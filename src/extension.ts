import { rename } from 'fs';
import * as vscode from 'vscode';

class DirectoryListingData {
	identifier: string;
	isDir: boolean;
	name: string;
	isNew: boolean;

	constructor(identifier: string, isDir: boolean, name: string, isNew: boolean) {
		this.identifier = identifier;
		this.isDir = isDir;
		this.name = name;
		this.isNew = isNew;
	}
}

class RenamedDirectoryListingItem{
	oldPath: string;
	newData: DirectoryListingData;

	constructor(oldPath: string, newData: DirectoryListingData) {
		this.oldPath = oldPath;
		this.newData = newData;
	}
}

async function showDeleteConfirmation(
    deletedIdentifiers: Map<string, DirectoryListingData[]>, renamedIdentifiers: Map<string, RenamedDirectoryListingItem>) {
    const panel = vscode.window.createWebviewPanel(
        'deleteConfirmation',
        'Delete Confirmation',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );

    let deletedItemsList = '';
    for (let [identifier, [{ isDir, name, isNew }]] of deletedIdentifiers) {
        deletedItemsList += `<li>${name}</li>`;
    }

    let renamedItemsList = '';
    for (let [identifier, renamedData] of renamedIdentifiers) {
        renamedItemsList += `<li>${renamedData.oldPath} → ${renamedData.newData.name}</li>`;
    }

    panel.webview.html = `
        <html>
        <body>
            <h2>Are you sure you want to delete the following files/directories?</h2>
            <ul>${deletedItemsList}</ul>
            <h2>Renamed Items:</h2>
            <ul>${renamedItemsList}</ul>
            <button id="noButton">No</button>
            <button id="yesButton">Yes</button>
            <script>
                const vscode = acquireVsCodeApi();
                document.getElementById('yesButton').addEventListener('click', () => {
                    vscode.postMessage({ command: 'yes' });
                });
                document.getElementById('noButton').addEventListener('click', () => {
                    vscode.postMessage({ command: 'no' });
                });
                window.addEventListener('DOMContentLoaded', () => {
                    document.getElementById('noButton').focus();
                });
            </script>
        </body>
        </html>
    `;

    return new Promise<string>((resolve) => {
        panel.webview.onDidReceiveMessage((message) => {
            panel.dispose();
            resolve(message.command === 'yes' ? 'Yes' : 'No');
        });
    });
}

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
			return pathToIdentifierMap.get(path)!;
		}
		let stringSize = 7;
		let identifier = generateRandomString(stringSize);

		while (identifierToPathMap.has(identifier)){
			identifier = generateRandomString(stringSize);
		}

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
		let result = '';
		let characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
		let charactersLength = characters.length;
		for (let i = 0; i < length; i++) {
			result += characters.charAt(Math.floor(Math.random() * charactersLength));
		}
		return result;
	};


	const parseLine = (line: string): DirectoryListingData => {
		let parts = line.split(' ');
		if (parts.length == 3){
			let identifier = parts[0];
			let typeString = parts[1];
			let name = parts.slice(2).join(' ').trim();
			return {
				identifier: identifier,
				isDir: typeString === '/',
				name: name,
				isNew: false,
			};
		}
		else{
			let typeString = parts[0];
			let name = parts.slice(1).join(' ').trim();
			return {
				identifier: '',
				isDir: typeString === '/',
				name: name,
				isNew: !name.startsWith('.')
			};

		}
	};


	const getIdentifiersFromContent = (content: string) => {
		let res: Map<string, DirectoryListingData[]> = new Map();
		for (let line of content.split('\n')){
			if (line.trim().length === 0) {
				continue;
			}
			let { identifier, isDir, name, isNew } = parseLine(line);
			let oldList: DirectoryListingData[] = res.get(identifier) || [];
			oldList.push({ identifier, isDir, name, isNew });
			res.set(identifier, oldList);
		}
		return res;
	};

	const handleSave = vscode.commands.registerCommand('vsoil.handleSave', async () => {
		let doc = await getVsoilDoc();
		let originalContent = await getContentForPath(currentDir!);
		var originalIdentifiers: Map<string, DirectoryListingData[]> = getIdentifiersFromContent(originalContent);
		let content = doc.getText();
		var newIdentifiers: Map<string, DirectoryListingData[]> = getIdentifiersFromContent(content);

		var copiedIdentifiers: Map<string, DirectoryListingData[]> = new Map();
		var renamedIdentifiers: Map<string, RenamedDirectoryListingItem> = new Map();

		for (let [identifier, items] of newIdentifiers){
			let originalPath = getPathForIdentifier(identifier);
			let originalParentPath = originalPath?.split('/').slice(0, -1).join('/');
			let isCurrentDirTheSameAsOriginal = currentDir?.path === originalParentPath;
			let newItems: DirectoryListingData[] = [];
			let originalExists = false;

			for (let item of items){
				let itemPath = vscode.Uri.joinPath(currentDir!, item.name).path;
				if (originalPath && originalPath !== itemPath){
					newItems.push(item);
				}
				else{
					originalExists = true;
				}
			}

			if (isCurrentDirTheSameAsOriginal){

				if (!originalExists && newItems.length > 0 && originalPath) {
					renamedIdentifiers.set(identifier, new RenamedDirectoryListingItem(originalPath, newItems[0]));
					newItems = newItems.slice(1);
				}

				if (newItems.length > 0) {
					copiedIdentifiers.set(identifier, newItems);
				}
			}
			else{
				if (newItems.length > 0){
					copiedIdentifiers.set(identifier, newItems);
				}
			}
		}

		for (let [identifier, item] of renamedIdentifiers){
			let originalPath = getPathForIdentifier(identifier);
			let newPath = vscode.Uri.joinPath(currentDir!, item.newData.name).path;
			// do the rename
			if (originalPath && newPath){
				await vscode.workspace.fs.rename(vscode.Uri.parse(originalPath), vscode.Uri.parse(newPath));
				// update the pathToIdentifierMap and identifierToPathMap
				pathToIdentifierMap.delete(originalPath);
				pathToIdentifierMap.set(newPath, identifier);
				identifierToPathMap.delete(identifier);
				identifierToPathMap.set(identifier, newPath);
			}
		}

		for (let [identifier, items] of copiedIdentifiers){
			let originalPath = getPathForIdentifier(identifier);
			for (let item of items){
				let newPath = vscode.Uri.joinPath(currentDir!, item.name).path;
				if (originalPath){
					await vscode.workspace.fs.copy(vscode.Uri.parse(originalPath), vscode.Uri.parse(newPath));
					// update the pathToIdentifierMap and identifierToPathMap
					let newIdentifier = getIdentifierForPath(newPath);
					pathToIdentifierMap.set(newPath, newIdentifier);
					identifierToPathMap.set(newIdentifier, newPath);
				}
			}
		}

		// get the identifiers that are in the original content but not in the new content
		var deletedIdentifiers: Map<string, DirectoryListingData[]> = new Map();
		for (let [identifier, obj] of originalIdentifiers){
			if (!newIdentifiers.has(identifier)){
				deletedIdentifiers.set(identifier, obj);
			}
		}

		if (deletedIdentifiers.size > 0 || renamedIdentifiers.size > 0){
			let response = await showDeleteConfirmation(deletedIdentifiers, renamedIdentifiers);
			// make sure the document has focus
			await vscode.window.showTextDocument(doc);
			if (response === 'Yes'){
				for (let [identifier, [{ isDir, name, isNew }]] of deletedIdentifiers){
					// delete the file/directory
					let path = getPathForIdentifier(identifier);
					if (path){
						if (isDir) {
							await vscode.workspace.fs.delete(vscode.Uri.parse(path), { recursive: true });
						}
						else {
							await vscode.workspace.fs.delete(vscode.Uri.parse(path));
						}

						pathToIdentifierMap.delete(path);
						identifierToPathMap.delete(identifier);

					}

				}
			}
		}

		let lines = content.split('\n');
		var modified = deletedIdentifiers.size > 0 || copiedIdentifiers.size > 0 || renamedIdentifiers.size > 0;
		for (let line of lines){
			if (line.trim().length === 0) {
				continue;
			}

			let { identifier, isDir, name, isNew } = parseLine(line);
			if (isNew) {
				let fullPath = vscode.Uri.joinPath(currentDir!, name + "/");

				if (isDir) {
					let pathParts = fullPath.path.split('/');
					let isLastPartFile = pathParts[pathParts.length - 1].includes('.');
					if (isLastPartFile){
						let lastPartParentDir = pathParts.slice(0, pathParts.length - 1).join('/');
						await vscode.workspace.fs.createDirectory(vscode.Uri.parse(lastPartParentDir));
						await vscode.workspace.fs.writeFile(fullPath, new Uint8Array());
					}
					else{
						await vscode.workspace.fs.createDirectory(fullPath);
					}
					modified = true;
				}
				else {
					await vscode.workspace.fs.writeFile(fullPath, new Uint8Array());
					modified = true;
				}
			}
		}

		if (modified){
			// pathToIdentifierMap.clear();
			// identifierToPathMap.clear();
			await updateDocContentToCurrentDir();
		}
	});

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
					let lineIndex = vsoilDoc?.getText().split('\n').findIndex((line) => line.trimEnd().endsWith(`/ ${focusLine}`));
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
				// compare file names. e.g. file1.txt should come before file10.txt even though lexicographically it should be the other way around
				return a[0].localeCompare(b[0], undefined, { numeric: true });

			}
			return a[1] === vscode.FileType.Directory ? -1 : 1;
		});

		content += `/ ..\n`;
		files.forEach((file) => {
			let isDir = file[1] === vscode.FileType.Directory;
			let fullPath = vscode.Uri.joinPath(rootUri!, file[0]).path;
			let identifier = getIdentifierForPath(fullPath);
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
		// move cursor to the first line
		let selection = new vscode.Selection(doc.positionAt(0), doc.positionAt(0));

		if (vscode.window.activeTextEditor){
			vscode.window.activeTextEditor.selection = selection;
		}

		vscode.commands.executeCommand('setContext', 'vsoilDoc', true);
		vscode.window.onDidChangeActiveTextEditor(editor => {
			vscode.commands.executeCommand('setContext', 'vsoilDoc', editor?.document ===  doc);
		});

	});

	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}
