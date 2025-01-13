import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {

	var currentDir = vscode.workspace.workspaceFolders?.[0].uri;
	var vsoilDoc: vscode.TextDocument | undefined = undefined;

	let getVsoilDoc = async () => {
		if (vsoilDoc) {
			return vsoilDoc;
		}
		// vsoilDoc = await vscode.workspace.openTextDocument({ content: '' });
		vsoilDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse('untitled:Vsoil'));
		return vsoilDoc;
	};

	// regsiters vsoil.handleEnter command
	const handleEnter = vscode.commands.registerCommand('vsoil.handleEnter', async () => {
		let currentCursorLineIndex = vscode.window.activeTextEditor?.selection.active.line;
		if (currentCursorLineIndex !== undefined) {
			let currentDirName = vsoilDoc?.getText(vsoilDoc.lineAt(currentCursorLineIndex).range).substring(2);
			let isDir = vsoilDoc?.getText(vsoilDoc.lineAt(currentCursorLineIndex).range).startsWith('/');
			var focusLine = '';

			if (isDir){
				if (currentDirName === '..') {
					// focusline should be the last part of current path
					let pathParts = currentDir?.path.split('/');
					focusLine = pathParts?.[pathParts.length - 1] ?? '';
					currentDir = vscode.Uri.joinPath(currentDir!, '..');
				}
				else {
					currentDir = vscode.Uri.joinPath(currentDir!, currentDirName!);
					if (vscode.window.activeTextEditor) {
						vscode.window.activeTextEditor.selection = new vscode.Selection(0, 0, 0, 0);
						vscode.window.activeTextEditor.revealRange(new vscode.Range(0, 0, 0, 0));
					}
				}
				await updateDocContentToCurrentDir();
				if (focusLine){
					let lineIndex = vsoilDoc?.getText().split('\n').findIndex((line) => line.startsWith(`/ ${focusLine}`));
					if (lineIndex !== undefined && lineIndex !== -1){
						let line = vsoilDoc?.lineAt(lineIndex);
						if (line){
							let selection = new vscode.Selection(line.range.start, line.range.start);
							if (vscode.window.activeTextEditor) {
								vscode.window.activeTextEditor.selection = selection;
								vscode.window.activeTextEditor.revealRange(new vscode.Range(selection.start, selection.end));
							}
						}
					}
				}
			}
			else{
				// open file
				let fileUri = vscode.Uri.joinPath(currentDir!, currentDirName!);
				let doc = await vscode.workspace.openTextDocument(fileUri);
				await vscode.window.showTextDocument(doc);
			}
		}

	});
	

	let updateDocContentToCurrentDir = async () => {
		let rootUri = currentDir;
		let files = await vscode.workspace.fs.readDirectory(rootUri!);
		let content = '';

		// first show directories and then files
		files.sort((a, b) => {
			if (a[1] === b[1]) {
				return a[0].localeCompare(b[0]);
			}
			return a[1] === vscode.FileType.Directory ? -1 : 1;
		});

		content += `/ ..\n`;
		files.forEach((file) => {
			let isDir = file[1] === vscode.FileType.Directory;
			if (isDir){
				content += `/ ${file[0]}\n`;
			}
			else{
				content += `- ${file[0]}\n`;
			}
		});
		let doc = await getVsoilDoc();
		// set doc content
		const edit = new vscode.WorkspaceEdit();
		const fullRange = new vscode.Range(
			doc.positionAt(0),
			doc.positionAt(doc.getText().length)
		);
		edit.replace(doc.uri, fullRange, content);
		await vscode.workspace.applyEdit(edit);
	};
	const disposable = vscode.commands.registerCommand('vsoil.startvsoil', async () => {


		let doc = await getVsoilDoc();
		currentDir = vscode.workspace.workspaceFolders?.[0].uri;
		await updateDocContentToCurrentDir();

		await vscode.window.showTextDocument(doc);
		vscode.commands.executeCommand('setContext', 'vsoilDoc', true);
		vscode.window.onDidChangeActiveTextEditor(editor => {
			vscode.commands.executeCommand('setContext', 'vsoilDoc', editor?.document ===  doc);
		});

	});

	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}
