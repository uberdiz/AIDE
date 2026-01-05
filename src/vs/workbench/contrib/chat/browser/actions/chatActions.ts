/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isAncestorOfActiveElement } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { toAction, WorkbenchActionExecutedClassification, WorkbenchActionExecutedEvent } from '../../../../../base/common/actions.js';
import { coalesce } from '../../../../../base/common/arrays.js';
import { timeout } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { safeIntl } from '../../../../../base/common/date.js';
import { Event } from '../../../../../base/common/event.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Disposable, markAsSingleton } from '../../../../../base/common/lifecycle.js';
import { language } from '../../../../../base/common/platform.js';
import { basename } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { EditorAction2 } from '../../../../../editor/browser/editorExtensions.js';
import { IRange } from '../../../../../editor/common/core/range.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IActionViewItemService } from '../../../../../platform/actions/browser/actionViewItemService.js';
import { DropdownWithPrimaryActionViewItem } from '../../../../../platform/actions/browser/dropdownWithPrimaryActionViewItem.js';
import { Action2, ICommandPaletteOptions, MenuId, MenuItemAction, MenuRegistry, registerAction2, SubmenuItemAction } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IsLinuxContext, IsWindowsContext } from '../../../../../platform/contextkey/common/contextkeys.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import product from '../../../../../platform/product/common/product.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { ToggleTitleBarConfigAction } from '../../../../browser/parts/titlebar/titlebarActions.js';
import { ActiveEditorContext, IsCompactTitleBarContext } from '../../../../common/contextkeys.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../../common/views.js';
import { ChatEntitlement, IChatEntitlementService } from '../../../../services/chat/common/chatEntitlementService.js';
import { AUX_WINDOW_GROUP } from '../../../../services/editor/common/editorService.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { IPreferencesService } from '../../../../services/preferences/common/preferences.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { EXTENSIONS_CATEGORY, IExtensionsWorkbenchService } from '../../../extensions/common/extensions.js';
import { SCMHistoryItemChangeRangeContentProvider, ScmHistoryItemChangeRangeUriFields } from '../../../scm/browser/scmHistoryChatContext.js';
import { ISCMService } from '../../../scm/common/scm.js';
import { IChatAgentResult, IChatAgentService } from '../../common/participants/chatAgents.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { ModifiedFileEntryState } from '../../common/editing/chatEditingService.js';
import { IChatModel, IChatResponseModel } from '../../common/model/chatModel.js';
import { ChatMode, IChatMode, IChatModeService } from '../../common/chatModes.js';
import { IChatService } from '../../common/chatService/chatService.js';
import { ISCMHistoryItemChangeRangeVariableEntry, ISCMHistoryItemChangeVariableEntry } from '../../common/attachments/chatVariableEntries.js';
import { IChatRequestViewModel, IChatResponseViewModel, isRequestVM } from '../../common/model/chatViewModel.js';
import { IChatWidgetHistoryService } from '../../common/widget/chatWidgetHistoryService.js';
import { ChatAgentLocation, ChatConfiguration, ChatModeKind } from '../../common/constants.js';
import { ILanguageModelChatSelector, ILanguageModelsService } from '../../common/languageModels.js';
import { CopilotUsageExtensionFeatureId } from '../../common/languageModelStats.js';
import { ILanguageModelToolsConfirmationService } from '../../common/tools/languageModelToolsConfirmationService.js';
import { ILanguageModelToolsService } from '../../common/tools/languageModelToolsService.js';
import { ChatViewId, IChatWidget, IChatWidgetService } from '../chat.js';
import { IChatEditorOptions } from '../widgetHosts/editor/chatEditor.js';
import { ChatEditorInput, showClearEditingSessionConfirmation } from '../widgetHosts/editor/chatEditorInput.js';
import { convertBufferToScreenshotVariable } from '../attachments/chatScreenshotContext.js';

export const CHAT_CATEGORY = localize2('chat.category', 'Chat');

export const ACTION_ID_NEW_CHAT = `workbench.action.chat.newChat`;
export const ACTION_ID_NEW_EDIT_SESSION = `workbench.action.chat.newEditSession`;
export const ACTION_ID_OPEN_CHAT = 'workbench.action.openChat';
export const CHAT_OPEN_ACTION_ID = 'workbench.action.chat.open';
export const CHAT_SETUP_ACTION_ID = 'workbench.action.chat.triggerSetup';
export const CHAT_SETUP_SUPPORT_ANONYMOUS_ACTION_ID = 'workbench.action.chat.triggerSetupSupportAnonymousAction';
const TOGGLE_CHAT_ACTION_ID = 'workbench.action.chat.toggle';

export interface IChatViewOpenOptions {
	/**
	 * The query for chat.
	 */
	query: string;
	/**
	 * Whether the query is partial and will await more input from the user.
	 */
	isPartialQuery?: boolean;
	/**
	 * A list of tools IDs with `canBeReferencedInPrompt` that will be resolved and attached if they exist.
	 */
	toolIds?: string[];
	/**
	 * Any previous chat requests and responses that should be shown in the chat view.
	 */
	previousRequests?: IChatViewOpenRequestEntry[];
	/**
	 * Whether a screenshot of the focused window should be taken and attached
	 */
	attachScreenshot?: boolean;
	/**
	 * A list of file URIs to attach to the chat as context.
	 */
	attachFiles?: (URI | { uri: URI; range: IRange })[];
	/**
	 * A list of source control history item changes to attach to the chat as context.
	 */
	attachHistoryItemChanges?: { uri: URI; historyItemId: string }[];
	/**
	 * A list of source control history item change ranges to attach to the chat as context.
	 */
	attachHistoryItemChangeRanges?: {
		start: { uri: URI; historyItemId: string };
		end: { uri: URI; historyItemId: string };
	}[];
	/**
	 * The mode ID or name to open the chat in.
	 */
	mode?: ChatModeKind | string;

	/**
	 * The language model selector to use for the chat.
	 * An Error will be thrown if there's no match. If there are multiple
	 * matches, the first match will be used.
	 *
	 * Examples:
	 *
	 * ```
	 * {
	 *   id: 'claude-sonnet-4',
	 *   vendor: 'copilot'
	 * }
	 * ```
	 *
	 * Use `claude-sonnet-4` from any vendor:
	 *
	 * ```
	 * {
	 *   id: 'claude-sonnet-4',
	 * }
	 * ```
	 */
	modelSelector?: ILanguageModelChatSelector;

	/**
	 * Wait to resolve the command until the chat response reaches a terminal state (complete, error, or pending user confirmation, etc.).
	 */
	blockOnResponse?: boolean;
}

export interface IChatViewOpenRequestEntry {
	request: string;
	response: string;
}

export const CHAT_CONFIG_MENU_ID = new MenuId('workbench.chat.menu.config');

const OPEN_CHAT_QUOTA_EXCEEDED_DIALOG = 'workbench.action.chat.openQuotaExceededDialog';

abstract class OpenChatGlobalAction extends Action2 {
	constructor(overrides: Pick<ICommandPaletteOptions, 'keybinding' | 'title' | 'id' | 'menu'>, private readonly mode?: IChatMode) {
		super({
			...overrides,
			icon: Codicon.chatSparkle,
			f1: true,
			category: CHAT_CATEGORY,
			precondition: ContextKeyExpr.and(
				ChatContextKeys.Setup.hidden.negate(),
				ChatContextKeys.Setup.disabled.negate()
			)
		});
	}

	override async run(accessor: ServicesAccessor, opts?: string | IChatViewOpenOptions): Promise<IChatAgentResult & { type?: 'confirmation' } | undefined> {
		opts = typeof opts === 'string' ? { query: opts } : opts;

		const chatService = accessor.get(IChatService);
		const widgetService = accessor.get(IChatWidgetService);
		const toolsService = accessor.get(ILanguageModelToolsService);
		const hostService = accessor.get(IHostService);
		const chatAgentService = accessor.get(IChatAgentService);
		const instaService = accessor.get(IInstantiationService);
		const commandService = accessor.get(ICommandService);
		const chatModeService = accessor.get(IChatModeService);
		const fileService = accessor.get(IFileService);
		const languageModelService = accessor.get(ILanguageModelsService);
		const scmService = accessor.get(ISCMService);
		const modelService = accessor.get(IModelService);

		let chatWidget = widgetService.lastFocusedWidget;
		// When this was invoked to switch to a mode via keybinding, and some chat widget is focused, use that one.
		// Otherwise, open the view.
		if (!this.mode || !chatWidget || !isAncestorOfActiveElement(chatWidget.domNode)) {
			chatWidget = await widgetService.revealWidget();
		}

		if (!chatWidget) {
			return;
		}

		const switchToMode = (opts?.mode ? chatModeService.findModeByName(opts?.mode) : undefined) ?? this.mode;
		if (switchToMode) {
			await this.handleSwitchToMode(switchToMode, chatWidget, instaService, commandService);
		}

		if (opts?.modelSelector) {
			const ids = await languageModelService.selectLanguageModels(opts.modelSelector, false);
			const id = ids.sort().at(0);
			if (!id) {
				throw new Error(`No language models found matching selector: ${JSON.stringify(opts.modelSelector)}.`);
			}

			const model = languageModelService.lookupLanguageModel(id);
			if (!model) {
				throw new Error(`Language model not loaded: ${id}.`);
			}

			chatWidget.input.setCurrentLanguageModel({ metadata: model, identifier: id });
		}

		if (opts?.previousRequests?.length && chatWidget.viewModel) {
			for (const { request, response } of opts.previousRequests) {
				chatService.addCompleteRequest(chatWidget.viewModel.sessionResource, request, undefined, 0, { message: response });
			}
		}
		if (opts?.attachScreenshot) {
			const screenshot = await hostService.getScreenshot();
			if (screenshot) {
				chatWidget.attachmentModel.addContext(convertBufferToScreenshotVariable(screenshot));
			}
		}
		if (opts?.attachFiles) {
			for (const file of opts.attachFiles) {
				const uri = file instanceof URI ? file : file.uri;
				const range = file instanceof URI ? undefined : file.range;

				if (await fileService.exists(uri)) {
					if (range) {
						const model = modelService.getModel(uri);
						if (model) {
							const code = model.getValueInRange(range);
							const language = model.getLanguageId();
							chatWidget.attachmentModel.addSelection(uri, range, code, language);
						} else {
							chatWidget.attachmentModel.addFile(uri, range);
						}
					} else {
						chatWidget.attachmentModel.addFile(uri);
					}
				}
			}
		}
		if (opts?.attachHistoryItemChanges) {
			for (const historyItemChange of opts.attachHistoryItemChanges) {
				const repository = scmService.getRepository(URI.file(historyItemChange.uri.path));
				const historyProvider = repository?.provider.historyProvider.get();
				if (!historyProvider) {
					continue;
				}

				const historyItem = await historyProvider.resolveHistoryItem(historyItemChange.historyItemId);
				if (!historyItem) {
					continue;
				}

				chatWidget.attachmentModel.addContext({
					id: historyItemChange.uri.toString(),
					name: `${basename(historyItemChange.uri)}`,
					value: historyItemChange.uri,
					historyItem: historyItem,
					kind: 'scmHistoryItemChange'
				} satisfies ISCMHistoryItemChangeVariableEntry);
			}
		}
		if (opts?.attachHistoryItemChangeRanges) {
			for (const historyItemChangeRange of opts.attachHistoryItemChangeRanges) {
				const repository = scmService.getRepository(URI.file(historyItemChangeRange.end.uri.path));
				const historyProvider = repository?.provider.historyProvider.get();
				if (!repository || !historyProvider) {
					continue;
				}

				const [historyItemStart, historyItemEnd] = await Promise.all([
					historyProvider.resolveHistoryItem(historyItemChangeRange.start.historyItemId),
					historyProvider.resolveHistoryItem(historyItemChangeRange.end.historyItemId),
				]);
				if (!historyItemStart || !historyItemEnd) {
					continue;
				}

				const uri = historyItemChangeRange.end.uri.with({
					scheme: SCMHistoryItemChangeRangeContentProvider.scheme,
					query: JSON.stringify({
						repositoryId: repository.id,
						start: historyItemStart.id,
						end: historyItemChangeRange.end.historyItemId
					} satisfies ScmHistoryItemChangeRangeUriFields)
				});

				chatWidget.attachmentModel.addContext({
					id: uri.toString(),
					name: `${basename(uri)}`,
					value: uri,
					historyItemChangeStart: {
						uri: historyItemChangeRange.start.uri,
						historyItem: historyItemStart
					},
					historyItemChangeEnd: {
						uri: historyItemChangeRange.end.uri,
						historyItem: {
							...historyItemEnd,
							displayId: historyItemChangeRange.end.historyItemId
						}
					},
					kind: 'scmHistoryItemChangeRange'
				} satisfies ISCMHistoryItemChangeRangeVariableEntry);
			}
		}

		let resp: Promise<IChatResponseModel | undefined> | undefined;

		if (opts?.query) {

			if (opts.isPartialQuery) {
				chatWidget.setInput(opts.query);
			} else {
				if (!chatWidget.viewModel) {
					await Event.toPromise(chatWidget.onDidChangeViewModel);
				}
				await waitForDefaultAgent(chatAgentService, chatWidget.input.currentModeKind);
				chatWidget.setInput(opts.query); // wait until the model is restored before setting the input, or it will be cleared when the model is restored
				resp = chatWidget.acceptInput();
			}
		}

		if (opts?.toolIds && opts.toolIds.length > 0) {
			for (const toolId of opts.toolIds) {
				const tool = toolsService.getTool(toolId);
				if (tool) {
					chatWidget.attachmentModel.addContext({
						id: tool.id,
						name: tool.displayName,
						fullName: tool.displayName,
						value: undefined,
						icon: ThemeIcon.isThemeIcon(tool.icon) ? tool.icon : undefined,
						kind: 'tool'
					});
				}
			}
		}

		chatWidget.focusInput();

		if (opts?.blockOnResponse) {
			const response = await resp;
			if (response) {
				await new Promise<void>(resolve => {
					const d = response.onDidChange(async () => {
						if (response.isComplete || response.isPendingConfirmation.get()) {
							d.dispose();
							resolve();
						}
					});
				});

				return { ...response.result, type: response.isPendingConfirmation.get() ? 'confirmation' : undefined };
			}
		}

		return undefined;
	}

	private async handleSwitchToMode(switchToMode: IChatMode, chatWidget: IChatWidget, instaService: IInstantiationService, commandService: ICommandService): Promise<void> {
		const currentMode = chatWidget.input.currentModeKind;

		if (switchToMode) {
			const model = chatWidget.viewModel?.model;
			const chatModeCheck = model ? await instaService.invokeFunction(handleModeSwitch, currentMode, switchToMode.kind, model.getRequests().length, model) : { needToClearSession: false };
			if (!chatModeCheck) {
				return;
			}
			chatWidget.input.setChatMode(switchToMode.id);

			if (chatModeCheck.needToClearSession) {
				await commandService.executeCommand(ACTION_ID_NEW_CHAT);
			}
		}
	}
}

async function waitForDefaultAgent(chatAgentService: IChatAgentService, mode: ChatModeKind): Promise<void> {
	const defaultAgent = chatAgentService.getDefaultAgent(ChatAgentLocation.Chat, mode);
	if (defaultAgent) {
		return;
	}

	await Promise.race([
		Event.toPromise(Event.filter(chatAgentService.onDidChangeAgents, () => {
			const defaultAgent = chatAgentService.getDefaultAgent(ChatAgentLocation.Chat, mode);
			return Boolean(defaultAgent);
		})),
		timeout(60_000).then(() => { throw new Error('Timed out waiting for default agent'); })
	]);
}

class PrimaryOpenChatGlobalAction extends OpenChatGlobalAction {
	constructor() {
		super({
			id: CHAT_OPEN_ACTION_ID,
			title: localize2('openChat', "Open Chat"),
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyI,
				mac: {
					primary: KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyCode.KeyI
				}
			},
			menu: [{
				id: MenuId.ChatTitleBarMenu,
				group: 'a_open',
				order: 1
			}]
		});
	}
}

export function getOpenChatActionIdForMode(mode: IChatMode): string {
	return `workbench.action.chat.open${mode.name.get()}`;
}

export abstract class ModeOpenChatGlobalAction extends OpenChatGlobalAction {
	constructor(mode: IChatMode, keybinding?: ICommandPaletteOptions['keybinding']) {
		super({
			id: getOpenChatActionIdForMode(mode),
			title: localize2('openChatMode', "Open Chat ({0})", mode.label.get()),
			keybinding
		}, mode);
	}
}

/* --- AIDE: Disabled chat actions
export function registerChatActions() {
	// registerAction2(PrimaryOpenChatGlobalAction);
	// registerAction2(class extends ModeOpenChatGlobalAction {
	// 	constructor() { super(ChatMode.Ask); }
	// });
	// registerAction2(class extends ModeOpenChatGlobalAction {
	// 	constructor() {
	// 		super(ChatMode.Agent, {
	// 			when: ContextKeyExpr.has(`config.${ChatConfiguration.AgentEnabled}`),
	// 			weight: KeybindingWeight.WorkbenchContrib,
	// 			primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyI,
	// 			linux: {
	// 				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyMod.Shift | KeyCode.KeyI
	// 			}
	// 		},);
	// 	}
	// });
	// registerAction2(class extends ModeOpenChatGlobalAction {
	// 	constructor() { super(ChatMode.Edit); }
	// });

	// registerAction2(class ToggleChatAction extends Action2 {
	// 	constructor() {
	// 		super({
	// 			id: TOGGLE_CHAT_ACTION_ID,
	// 			title: localize2('toggleChat', "Toggle Chat"),
	// 			category: CHAT_CATEGORY
	// 		});
	// 	}

	// 	async run(accessor: ServicesAccessor) {
	// 		const layoutService = accessor.get(IWorkbenchLayoutService);
	// 		const viewsService = accessor.get(IViewsService);
	// 		const viewDescriptorService = accessor.get(IViewDescriptorService);
	// 		const widgetService = accessor.get(IChatWidgetService);

	// 		const chatLocation = viewDescriptorService.getViewLocationById(ChatViewId);

	// 		if (viewsService.isViewVisible(ChatViewId)) {
	// 			this.updatePartVisibility(layoutService, chatLocation, false);
	// 		} else {
	// 			this.updatePartVisibility(layoutService, chatLocation, true);
	// 			(await widgetService.revealWidget())?.focusInput();
	// 		}
	// 	}

	// 	private updatePartVisibility(layoutService: IWorkbenchLayoutService, location: ViewContainerLocation | null, visible: boolean): void {
	// 		let part: Parts.PANEL_PART | Parts.SIDEBAR_PART | Parts.AUXILIARYBAR_PART | undefined;
	// 		switch (location) {
	// 			case ViewContainerLocation.Panel:
	// 				part = Parts.PANEL_PART;
	// 				break;
	// 			case ViewContainerLocation.Sidebar:
	// 				part = Parts.SIDEBAR_PART;
	// 				break;
	// 			case ViewContainerLocation.AuxiliaryBar:
	// 				part = Parts.AUXILIARYBAR_PART;
	// 				break;
	// 		}

	// 		if (part) {
	// 			layoutService.setPartHidden(!visible, part);
	// 		}
	// 	}
	// });


	// registerAction2(class NewChatEditorAction extends Action2 {
	// 	constructor() {
	// 		super({
	// 			id: ACTION_ID_OPEN_CHAT,
	// 			title: localize2('interactiveSession.open', "New Chat Editor"),
	// 			icon: Codicon.plus,
	// 			f1: true,
	// 			category: CHAT_CATEGORY,
	// 			precondition: ChatContextKeys.enabled,
	// 			keybinding: {
	// 				weight: KeybindingWeight.WorkbenchContrib,
	// 				primary: KeyMod.CtrlCmd | KeyCode.KeyN,
*/
/* --- AIDE: Disabled chat actions
export function registerChatActions() {
	// registerAction2(PrimaryOpenChatGlobalAction);
	// registerAction2(class extends ModeOpenChatGlobalAction {
	// 	constructor() { super(ChatMode.Ask); }
	// });
	// ... (rest of the actions commented out)
*/
export function registerChatActions() {
}

/* --- AIDE: Disabled title bar chat controls
// MenuRegistry.appendMenuItem(MenuId.CommandCenter, {
// ...
// });
*/

			}, undefined, undefined, undefined, undefined), dropdownAction, action.actions, '', { ...options, skipTelemetry: true });
		}, Event.any(
	chatEntitlementService.onDidChangeSentiment,
	chatEntitlementService.onDidChangeQuotaExceeded,
	chatEntitlementService.onDidChangeEntitlement,
	chatEntitlementService.onDidChangeAnonymous
));

// Reduces flicker a bit on reload/restart
markAsSingleton(disposable);
	}
}

/**
 * Returns whether we can continue clearing/switching chat sessions, false to cancel.
 */
export async function handleCurrentEditingSession(model: IChatModel, phrase: string | undefined, dialogService: IDialogService): Promise<boolean> {
	return showClearEditingSessionConfirmation(model, dialogService, { messageOverride: phrase });
}

/**
 * Returns whether we can switch the agent, based on whether the user had to agree to clear the session, false to cancel.
 */
export async function handleModeSwitch(
	accessor: ServicesAccessor,
	fromMode: ChatModeKind,
	toMode: ChatModeKind,
	requestCount: number,
	model: IChatModel | undefined,
): Promise<false | { needToClearSession: boolean }> {
	if (!model?.editingSession || fromMode === toMode) {
		return { needToClearSession: false };
	}

	const configurationService = accessor.get(IConfigurationService);
	const dialogService = accessor.get(IDialogService);
	const needToClearEdits = (!configurationService.getValue(ChatConfiguration.Edits2Enabled) && (fromMode === ChatModeKind.Edit || toMode === ChatModeKind.Edit)) && requestCount > 0;
	if (needToClearEdits) {
		// If not using edits2 and switching into or out of edit mode, ask to discard the session
		const phrase = localize('switchMode.confirmPhrase', "Switching agents will end your current edit session.");

		const currentEdits = model.editingSession.entries.get();
		const undecidedEdits = currentEdits.filter((edit) => edit.state.get() === ModifiedFileEntryState.Modified);
		if (undecidedEdits.length > 0) {
			if (!await handleCurrentEditingSession(model, phrase, dialogService)) {
				return false;
			}

			return { needToClearSession: true };
		} else {
			const confirmation = await dialogService.confirm({
				title: localize('agent.newSession', "Start new session?"),
				message: localize('agent.newSessionMessage', "Changing the agent will end your current edit session. Would you like to change the agent?"),
				primaryButton: localize('agent.newSession.confirm', "Yes"),
				type: 'info'
			});
			if (!confirmation.confirmed) {
				return false;
			}

			return { needToClearSession: true };
		}
	}

	return { needToClearSession: false };
}

export interface IClearEditingSessionConfirmationOptions {
	titleOverride?: string;
	messageOverride?: string;
	isArchiveAction?: boolean;
}


/* --- AIDE: Disabled chat submenus and other actions
// MenuRegistry.appendMenuItem(MenuId.EditorContext, {
// ...
// });
*/

