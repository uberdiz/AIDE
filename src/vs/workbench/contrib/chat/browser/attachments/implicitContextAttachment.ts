/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { StandardMouseEvent } from '../../../../../base/browser/mouseEvent.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { basename, dirname } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { Location } from '../../../../../editor/common/languages.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { localize } from '../../../../../nls.js';
import { getFlatContextMenuActions } from '../../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IMenuService, MenuId } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { FileKind, IFileService } from '../../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IResourceLabel, ResourceLabels } from '../../../../browser/labels.js';
import { ResourceContextKey } from '../../../../common/contextkeys.js';
import { IChatRequestImplicitVariableEntry, IChatRequestStringVariableEntry, isStringImplicitContextValue } from '../../common/attachments/chatVariableEntries.js';
import { IChatWidget } from '../chat.js';
import { ChatAttachmentModel } from './chatAttachmentModel.js';
import { IChatContextService } from '../contextContrib/chatContextService.js';

export class ImplicitContextAttachmentWidget extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly renderDisposables = this._register(new DisposableStore());

	constructor(
		private readonly widgetRef: () => IChatWidget | undefined,
		private readonly attachment: IChatRequestImplicitVariableEntry,
		private readonly resourceLabels: ResourceLabels,
		private readonly attachmentModel: ChatAttachmentModel,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@ILabelService private readonly labelService: ILabelService,
		@IMenuService private readonly menuService: IMenuService,
		@IFileService private readonly fileService: IFileService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IModelService private readonly modelService: IModelService,
		@IHoverService private readonly hoverService: IHoverService,
		@IConfigurationService private readonly configService: IConfigurationService,
		@IChatContextService private readonly chatContextService: IChatContextService,
	) {
		super();

		this.domNode = dom.$('.chat-attached-context-attachment.show-file-icons.implicit');
		this.render();
	}

	private render() {
		dom.clearNode(this.domNode);
		this.renderDisposables.clear();

		this.domNode.classList.toggle('disabled', !this.attachment.enabled);
		const file: URI | undefined = this.attachment.uri;
		const isNotebookCell = file?.scheme === Schemas.vscodeNotebookCell;
		const attachmentTypeName = isNotebookCell ? localize('cell.lowercase', "cell") : localize('file.lowercase', "file");

		const isSuggestedEnabled = !!this.configService.getValue<boolean>('chat.implicitContext.suggestedContext');

		// Create toggle button BEFORE the label so it appears on the left
		if (isSuggestedEnabled) {
			if (!this.attachment.isSelection) {
				const buttonTitle = this.attachment.enabled ? localize('disable', "Disable current {0} context", attachmentTypeName) : '';
				const toggleButton = this.renderDisposables.add(new Button(this.domNode, { supportIcons: true, title: buttonTitle }));
				toggleButton.icon = this.attachment.enabled ? Codicon.x : Codicon.plus;
				this.renderDisposables.add(toggleButton.onDidClick(async (e) => {
					e.stopPropagation();
					e.preventDefault();
					if (!this.attachment.enabled) {
						await this.convertToRegularAttachment();
					}
					this.attachment.enabled = false;
				}));
			} else {
				const pinButtonTitle = localize('pinSelection', "Pin selection");
				const pinButton = this.renderDisposables.add(new Button(this.domNode, { supportIcons: true, title: pinButtonTitle }));
				pinButton.icon = Codicon.pinned;
				this.renderDisposables.add(pinButton.onDidClick(async (e) => {
					e.stopPropagation();
					e.preventDefault();
					await this.pinSelection();
				}));
			}

			if (!this.attachment.enabled && this.attachment.isSelection) {
				this.domNode.classList.remove('disabled');
			}

			this.renderDisposables.add(dom.addDisposableListener(this.domNode, dom.EventType.CLICK, async (e) => {
				if (!this.attachment.enabled && !this.attachment.isSelection) {
					await this.convertToRegularAttachment();
				}
			}));

			this.renderDisposables.add(dom.addDisposableListener(this.domNode, dom.EventType.KEY_DOWN, async (e) => {
				const event = new StandardKeyboardEvent(e);
				if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
					if (!this.attachment.enabled && !this.attachment.isSelection) {
						e.preventDefault();
						e.stopPropagation();
						await this.convertToRegularAttachment();
					}
				}
			}));
		} else {
			const buttonTitle = this.attachment.enabled ? localize('disable', "Disable current {0} context", attachmentTypeName) : localize('enable', "Enable current {0} context", attachmentTypeName);
			const toggleButton = this.renderDisposables.add(new Button(this.domNode, { supportIcons: true, title: buttonTitle }));
			toggleButton.icon = this.attachment.enabled ? Codicon.eye : Codicon.eyeClosed;
			this.renderDisposables.add(toggleButton.onDidClick((e) => {
				e.stopPropagation(); // prevent it from triggering the click handler on the parent immediately after rerendering
				this.attachment.enabled = !this.attachment.enabled;
			}));
		}

		const label = this.resourceLabels.create(this.domNode, { supportIcons: true });

		let title: string;
		if (isStringImplicitContextValue(this.attachment.value)) {
			title = this.renderString(this.attachment.value, label);
		} else {
			title = this.renderResource(this.attachment.value, label);
		}

		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), this.domNode, title));

		// Context menu
		const scopedContextKeyService = this.renderDisposables.add(this.contextKeyService.createScoped(this.domNode));

		const resourceContextKey = this.renderDisposables.add(new ResourceContextKey(scopedContextKeyService, this.fileService, this.languageService, this.modelService));
		resourceContextKey.set(file);

		this.renderDisposables.add(dom.addDisposableListener(this.domNode, dom.EventType.CONTEXT_MENU, domEvent => {
			const event = new StandardMouseEvent(dom.getWindow(domEvent), domEvent);
			dom.EventHelper.stop(domEvent, true);

			this.contextMenuService.showContextMenu({
				contextKeyService: scopedContextKeyService,
				getAnchor: () => event,
				getActions: () => {
					const menu = this.menuService.getMenuActions(MenuId.ChatInputResourceAttachmentContext, scopedContextKeyService, { arg: file });
					return getFlatContextMenuActions(menu);
				},
			});
		}));
	}

	private renderString(value: IChatRequestStringVariableEntry | undefined, resourceLabel: IResourceLabel): string {
		const label = this.attachment.name;
		const icon = this.attachment.icon;
		const title = localize('openFile', "Current file context");
		resourceLabel.setLabel(label, undefined, { iconPath: icon, title });
		this.domNode.ariaLabel = title;
		this.domNode.tabIndex = 0;
		return title;
	}

	private renderResource(attachmentValue: Location | URI | undefined, label: IResourceLabel): string {
		const file = URI.isUri(attachmentValue) ? attachmentValue : attachmentValue?.uri;
		if (!file) {
			return '';
		}
		const range = (URI.isUri(attachmentValue) || !this.attachment.isSelection) ? undefined : attachmentValue?.range;

		const isNotebookCell = file.scheme === Schemas.vscodeNotebookCell;
		const attachmentTypeName = isNotebookCell ? localize('cell.lowercase', "cell") : localize('file.lowercase', "file");

		const fileBasename = basename(file);
		const fileDirname = dirname(file);
		const friendlyName = `${fileBasename} ${fileDirname}`;
		const ariaLabel = range
			? localize('chat.fileAttachmentWithRange', "Attached {0}, {1}, line {2} to line {3}", attachmentTypeName, friendlyName, range.startLineNumber, range.endLineNumber)
			: localize('chat.fileAttachment', "Attached {0}, {1}", attachmentTypeName, friendlyName);

		const uriLabel = this.labelService.getUriLabel(file, { relative: true });
		const currentFileLabel = localize('openEditor', "Current {0} context", attachmentTypeName);
		const inactiveLabel = localize('enableHint', "Enable current {0} context", attachmentTypeName);
		const currentFileHint = (this.attachment.enabled || this.attachment.isSelection) ? currentFileLabel : inactiveLabel;
		const title = `${currentFileHint}\n${uriLabel}`;

		label.setFile(file, {
			fileKind: FileKind.FILE,
			hidePath: true,
			range,
			title
		});
		this.domNode.ariaLabel = ariaLabel;
		this.domNode.tabIndex = 0;

		return title;
	}

	private async convertToRegularAttachment(): Promise<void> {
		const value = this.attachment.value;
		if (!value) {
			return;
		}

		if (isStringImplicitContextValue(value)) {
			if (value.value === undefined) {
				await this.chatContextService.resolveChatContext(value);
			}
			const context: IChatRequestStringVariableEntry = {
				kind: 'string',
				value: value.value,
				id: this.attachment.id,
				name: this.attachment.name,
				icon: value.icon,
				modelDescription: value.modelDescription,
				uri: value.uri
			};
			this.attachmentModel.addContext(context);
		} else {
			const file = URI.isUri(value) ? value : value.uri;
			if (file) {
				this.attachmentModel.addFile(file);
			}
		}
		this.widgetRef()?.focusInput();
	}

	private async pinSelection(): Promise<void> {
		const value = this.attachment.value;
		if (!value || !this.attachment.isSelection) {
			return;
		}

		if (!URI.isUri(value) && !isStringImplicitContextValue(value)) {
			const location = value;
			const model = this.modelService.getModel(location.uri);
			if (model) {
				const range = Range.lift(location.range);
				const code = model.getValueInRange(range);
				const language = model.getLanguageId();
				this.attachmentModel.addSelection(location.uri, range, code, language);
			} else {
				this.attachmentModel.addFile(location.uri, location.range);
			}
		}
		this.widgetRef()?.focusInput();
	}
}
