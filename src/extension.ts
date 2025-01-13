import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {

	var currentDir = vscode.workspace.workspaceFolders?.[0].uri;
	var vsoilDoc: vscode.TextDocument | undefined = undefined;

	var pathToIdentifierMap: Map<string, string> = new Map();
	var identifierToPathMap: Map<string, string> = new Map();

	let getVsoilDoc = async () => {
		if (vsoilDoc) {
			return vsoilDoc;
		}
		// vsoilDoc = await vscode.workspace.openTextDocument({ content: '' });
		vsoilDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse('untitled:Vsoil'));
		return vsoilDoc;
	};

	let getIdentifierForPath = (path: string) => {
		if (pathToIdentifierMap.has(path)){
			return pathToIdentifierMap.get(path);
		}
		let identifier = generateRandomString(5);
		pathToIdentifierMap.set(path, identifier);
		identifierToPathMap.set(identifier, path);
		return identifier;
	}

	let getPathForIdentifier = (identifier: string) => {
		if (identifierToPathMap.has(identifier)){
			return identifierToPathMap.get(identifier);
		}
		return '';
	}

	let generateRandomString = (length: number) => {
		// generate a random alphanumeric string of length `length`
		let result = '';
		let characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let charactersLength = characters.length;
		for (let i = 0; i < length; i++) {
			result += characters.charAt(Math.floor(Math.random() * charactersLength));
		}
		return result;
	};

	const parseLine = (line: string) => {
		let parts = line.split(' ');
		if (parts.length == 3){
			let identifier = parts[0];
			let typeString = parts[1];
			let name = parts.slice(2).join(' ');
			return {
				identifier: identifier,
				isDir: typeString === '/',
				name: name
			};
		}
		else{
			let typeString = parts[0];
			let name = parts[1];
			return {
				identifier: '',
				isDir: typeString === '/',
				name: name
			};

		}
	};

	const handleEnter = vscode.commands.registerCommand('vsoil.handleEnter', async () => {
		let currentCursorLineIndex = vscode.window.activeTextEditor?.selection.active.line;
		if (currentCursorLineIndex !== undefined) {
			let {identifier, isDir, name} = parseLine(vsoilDoc?.getText(vsoilDoc.lineAt(currentCursorLineIndex).range) ?? '');
			let currentDirName = name;
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
	

	const getContentForPath = async (rootUri: vscode.Uri) => {
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
			let fullPath = vscode.Uri.joinPath(rootUri!, file[0]).path;
			let identifier = getIdentifierForPath(fullPath);
			console.log(fullPath);
			if (isDir){
				content += `${identifier} / ${file[0]}\n`;
			}
			else{
				content += `${identifier} - ${file[0]}\n`;
			}
		});
		return content;
	}

	let updateDocContentToCurrentDir = async () => {
		let rootUri = currentDir;
		let content = await getContentForPath(rootUri!);
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
