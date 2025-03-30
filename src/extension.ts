import { commands, ExtensionContext, window } from 'vscode';
import { registerDevToolCommand } from './extension/features/register-dev-tool';
import { registerWelcomeMessage } from './extension/features/register-welcome-message';
import { CustomEvent } from './extension/views/custom-event';
import { registerWebViewProvider } from "./extension/views/register-webview-provider";

export function activate(context: ExtensionContext) {
	const op = window.createOutputChannel('InfinitePOC');
	registerWelcomeMessage(context);
	registerWebViewProvider(context);
	registerDevToolCommand(context);
	commands.executeCommand('setContext', 'isPrintContextMenu', true);

	CustomEvent.customEvent.subscribe(data => window.showInformationMessage('Message from event: ' + data));
}

export function deactivate() { }
