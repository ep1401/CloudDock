import { commands, ExtensionContext, window } from 'vscode';
import { registerDevToolCommand } from './extension/commands/register-dev-tool';
import { registerWelcomeMessage } from './extension/commands/register-welcome-message';
import { CustomEvent } from './extension/utils/custom-event';
import { registerWebViewProvider } from "./extension/webviews/register-webview-provider";

export function activate(context: ExtensionContext) {
	const op = window.createOutputChannel('InfinitePOC');
	registerWelcomeMessage(context);
	registerWebViewProvider(context);
	registerDevToolCommand(context);
	commands.executeCommand('setContext', 'isPrintContextMenu', true);

	CustomEvent.customEvent.subscribe(data => window.showInformationMessage('Message from event: ' + data));
}

export function deactivate() { }
