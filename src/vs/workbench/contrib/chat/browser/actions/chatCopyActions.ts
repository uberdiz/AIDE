/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { katexContainerClassName, katexContainerLatexAttributeName } from '../../../markdown/common/markedKatexExtension.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { IChatRequestViewModel, IChatResponseViewModel, isChatTreeItem, isRequestVM, isResponseVM } from '../../common/model/chatViewModel.js';
import { ChatTreeItem, IChatWidgetService } from '../chat.js';
import { CHAT_CATEGORY } from './chatActions.js';

function stringifyItem(item: ChatTreeItem | IChatRequestViewModel | IChatResponseViewModel | undefined, includeMetadata = true): string {
	if (!item) {
		return '';
	}

	// Try request/response view model fields first
	if (isRequestVM(item) || isResponseVM(item)) {
		const anyItem = item as any;
		const candidates = [
			anyItem.text,
			anyItem.content,
			anyItem.value,
			anyItem.label,
			anyItem.message && (anyItem.message.text || anyItem.message.content),
		];

		for (const c of candidates) {
			if (typeof c === 'string' && c.length) {
				return c;
			}
		}
	}

	// Fallback for generic chat tree items
	if (isChatTreeItem(item)) {
		const chatItem = item as ChatTreeItem;
		return (chatItem as any).label ?? '';
	}

	try {
		return typeof item === 'string' ? item : JSON.stringify(item);
	} catch {
		return String(item);
	}
}
import { toPromptTextVariableEntry } from '../../common/attachments/chatVariableEntries.js';

export function registerChatCopyActions() {
	registerAction2(class CopyAllAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.copyAll',
				title: localize2('interactive.copyAll.label', "Copy All"),
				f1: false,
				category: CHAT_CATEGORY,
				menu: {
					id: MenuId.ChatContext,
					when: ChatContextKeys.responseIsFiltered.negate(),
					group: 'copy',
				}
			});
		}

		run(accessor: ServicesAccessor, context?: ChatTreeItem) {
			const clipboardService = accessor.get(IClipboardService);
			const chatWidgetService = accessor.get(IChatWidgetService);
			const widget = (context?.sessionResource && chatWidgetService.getWidgetBySessionResource(context.sessionResource)) || chatWidgetService.lastFocusedWidget;
			if (widget) {
				const viewModel = widget.viewModel;
				const sessionAsText = viewModel?.getItems()
					.filter((item): item is (IChatRequestViewModel | IChatResponseViewModel) => isRequestVM(item) || (isResponseVM(item) && !item.errorDetails?.responseIsFiltered))
					.map(item => stringifyItem(item))
					.join('\n\n');
				if (sessionAsText) {
					clipboardService.writeText(sessionAsText);
				}
			}
		}
	});

	registerAction2(class AddItemToChatAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.addItemToChat',
				title: localize2('interactive.addItemToChat.label', "Add to Chat"),
				f1: false,
				category: CHAT_CATEGORY,
				menu: {
					id: MenuId.ChatContext,
					group: 'attach',
					order: 1,
					when: ChatContextKeys.responseIsFiltered.negate(),
				}
			});
		}

		async run(accessor: ServicesAccessor, ...args: unknown[]) {
			const chatWidgetService = accessor.get(IChatWidgetService);
			const widget = chatWidgetService.lastFocusedWidget;
			let item = args[0] as ChatTreeItem | undefined;
			if (!isChatTreeItem(item)) {
				item = widget?.getFocus();
			}
			if (!item || !widget) {
				return;
			}

			// Prefer DOM selection inside the widget if present
			const nativeSelection = dom.getActiveWindow().getSelection();
			let text = '';
			if (widget && nativeSelection && nativeSelection.rangeCount > 0 && dom.isAncestor(dom.getActiveElement(), widget.domNode)) {
				text = nativeSelection.toString();
			}
			if (!text) {
				text = stringifyItem(item);
			}
			if (!text) {
				return;
			}

			// Instead of pasting the selection/content into the prompt, attach
			// a small generic filename-like box. We avoid embedding the raw
			// content here.
			const itemLabel = isChatTreeItem(item) ? ((item as any).label ?? '') : '';
			const entry = {
				id: 'chat.added.fromMessage.' + Date.now(),
				name: localize2('chat.addedFromChat', "Added from Chat"),
				fullName: itemLabel || undefined,
				value: undefined,
				kind: 'generic'
			} as unknown as import('../../common/attachments/chatVariableEntries.js').IGenericChatRequestVariableEntry;

			widget.focusInput();
			widget.attachmentModel.addContext(entry);
			widget.focusInput();
		}
	});

	registerAction2(class CopyItemAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.copyItem',
				title: localize2('interactive.copyItem.label', "Copy"),
				f1: false,
				category: CHAT_CATEGORY,
				menu: {
					id: MenuId.ChatContext,
					when: ChatContextKeys.responseIsFiltered.negate(),
					group: 'copy',
				}
			});
		}

		async run(accessor: ServicesAccessor, ...args: unknown[]) {
			const chatWidgetService = accessor.get(IChatWidgetService);
			const clipboardService = accessor.get(IClipboardService);

			const widget = chatWidgetService.lastFocusedWidget;
			let item = args[0] as ChatTreeItem | undefined;
			if (!isChatTreeItem(item)) {
				item = widget?.getFocus();
				if (!item) {
					return;
				}
			}

			// If there is a text selection, and focus is inside the widget, copy the selected text.
			// Otherwise, context menu with no selection -> copy the full item
			const nativeSelection = dom.getActiveWindow().getSelection();
			const selectedText = nativeSelection?.toString();
			if (widget && selectedText && selectedText.length > 0 && dom.isAncestor(dom.getActiveElement(), widget.domNode)) {
				await clipboardService.writeText(selectedText);
				return;
			}

			const text = stringifyItem(item, false);
			await clipboardService.writeText(text);
		}
	});

	registerAction2(class CopyKatexMathSourceAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.copyKatexMathSource',
				title: localize2('chat.copyKatexMathSource.label', "Copy Math Source"),
				f1: false,
				category: CHAT_CATEGORY,
				menu: {
					id: MenuId.ChatContext,
					group: 'copy',
					when: ChatContextKeys.isKatexMathElement,
				}
			});
		}

		async run(accessor: ServicesAccessor, ...args: unknown[]) {
			const chatWidgetService = accessor.get(IChatWidgetService);
			const clipboardService = accessor.get(IClipboardService);

			const widget = chatWidgetService.lastFocusedWidget;
			let item = args[0] as ChatTreeItem | undefined;
			if (!isChatTreeItem(item)) {
				item = widget?.getFocus();
				if (!item) {
					return;
				}
			}

			// Try to find a KaTeX element from the selection or active element
			let selectedElement: Node | null = null;

			// If there is a selection, and focus is inside the widget, extract the inner KaTeX element.
			const activeElement = dom.getActiveElement();
			const nativeSelection = dom.getActiveWindow().getSelection();
			if (widget && nativeSelection && nativeSelection.rangeCount > 0 && dom.isAncestor(activeElement, widget.domNode)) {
				const range = nativeSelection.getRangeAt(0);
				selectedElement = range.commonAncestorContainer;

				// If it's a text node, get its parent element
				if (selectedElement.nodeType === Node.TEXT_NODE) {
					selectedElement = selectedElement.parentElement;
				}
			}

			// Otherwise, fallback to querying from the active element
			if (!selectedElement) {
				// eslint-disable-next-line no-restricted-syntax
				selectedElement = activeElement?.querySelector(`.${katexContainerClassName}`) ?? null;
			}

			// Extract the LaTeX source from the annotation element
			const katexElement = dom.isHTMLElement(selectedElement) ? selectedElement.closest(`.${katexContainerClassName}`) : null;
			const latexSource = katexElement?.getAttribute(katexContainerLatexAttributeName) || '';
			if (latexSource) {
				await clipboardService.writeText(latexSource);
			}
		}
	});
}
