import { rename } from 'fs';
import * as vscode from 'vscode';
import * as path from 'path';

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

function getFileSizeHumanReadableName(sizeInBytes: number) {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let unitIndex = 0;
	while (sizeInBytes >= 1024 && unitIndex < units.length - 1) {
		sizeInBytes /= 1024;
		unitIndex++;
	}
	return `${sizeInBytes.toFixed(2)} ${units[unitIndex]}`;
}

async function showDeleteConfirmation(
    deletedIdentifiers: Map<string, DirectoryListingData[]>, renamedIdentifiers: Map<string, RenamedDirectoryListingItem>, movedIdentifiers: Map<string, RenamedDirectoryListingItem>) {
    const panel = vscode.window.createWebviewPanel(
        'deleteConfirmation',
        'Delete Confirmation',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );

    let deletedItemsList = '';
    for (let [identifier, [{ isDir, name, isNew }]] of deletedIdentifiers) {
        deletedItemsList += `<li style="color:red;">${name}</li>`;
    }

    let renamedItemsList = '';
    for (let [identifier, renamedData] of renamedIdentifiers) {
        renamedItemsList += `<li style="color:green;">${renamedData.oldPath} → ${renamedData.newData.name}</li>`;
    }

    let movedItemsList = '';
    for (let [identifier, movedData] of movedIdentifiers) {
        movedItemsList += `<li style="color:yellow;">${movedData.oldPath} → ${movedData.newData.name}</li>`;
    }

	panel.webview.html = `
        <html>
        <body>
            <h2>Are you sure you want to delete/rename/move the following files/directories?</h2>
            <h2>Deleted Items:</h2>
            <ul>${deletedItemsList}</ul>
            <h2>Renamed Items:</h2>
            <ul>${renamedItemsList}</ul>
            <h2>Moved Items:</h2>
            <ul>${movedItemsList}</ul>
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
	var previewDoc: vscode.TextDocument | undefined = undefined;

	var pathToIdentifierMap: Map<string, string> = new Map();
	var identifierToPathMap: Map<string, string> = new Map();
	var cutIdentifiers = new Set<string>();

	let previewEnabled = false;

	const togglePreview = vscode.commands.registerCommand('vsoil.togglePreview', () => {
		previewEnabled = !previewEnabled;
	});

	const openCurrentDirectory = vscode.commands.registerCommand('vsoil.openCurrentDirectory', () => {
		if (currentDir) {
			// open the operating system's file explorer in the current directory
			vscode.env.openExternal(vscode.Uri.file(currentDir.path));
		}
	});

	context.subscriptions.push(togglePreview);

	let getVsoilDoc = async () => {
		if (vsoilDoc) {
			return vsoilDoc;
		}
		// vsoilDoc = await vscode.workspace.openTextDocument({ content: '' });
		vsoilDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse('untitled:Vsoil'));
		return vsoilDoc;
	};

	let getPreviewDoc = async () => {
		if (previewDoc) {
			return previewDoc;
		}
		previewDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse('untitled:Vsoil:preview'));
		return previewDoc;
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
		// find the first index of '-' or '/'
		let regexp = new RegExp('[-/]');
		let index = line.search(regexp);
		let hasIdentifier = index !== 0;

		let parts = line.split(' ');
		if (hasIdentifier){
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
		var movedIdentifiers: Map<string, RenamedDirectoryListingItem> = new Map();
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
					if (cutIdentifiers.has(identifier)){
						let firstItem = newItems[0];
						let rest = newItems.slice(1);
						movedIdentifiers.set(identifier, new RenamedDirectoryListingItem(originalPath!, firstItem));
						if (rest.length > 0){
							copiedIdentifiers.set(identifier, rest);
						}
					}
					else{
						copiedIdentifiers.set(identifier, newItems);
					}
				}
			}
		}


		for (let [identifier, items] of copiedIdentifiers){
			let originalPath = getPathForIdentifier(identifier);
			for (let item of items){
				let newPath = vscode.Uri.joinPath(currentDir!, item.name).path;
				if (originalPath){
					await vscode.workspace.fs.copy(vscode.Uri.parse(originalPath), vscode.Uri.parse(newPath));

					let newIdentifier = getIdentifierForPath(newPath);
					pathToIdentifierMap.set(newPath, newIdentifier);
					identifierToPathMap.set(newIdentifier, newPath);
				}
			}
		}


		var deletedIdentifiers: Map<string, DirectoryListingData[]> = new Map();
		for (let [identifier, obj] of originalIdentifiers){
			if (!newIdentifiers.has(identifier)){
				deletedIdentifiers.set(identifier, obj);
			}
		}

		if (deletedIdentifiers.size > 0 || renamedIdentifiers.size > 0 || movedIdentifiers.size > 0){
			let response = await showDeleteConfirmation(deletedIdentifiers, renamedIdentifiers, movedIdentifiers);
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
				for (let [identifier, item] of renamedIdentifiers) {
					let originalPath = getPathForIdentifier(identifier);
					let newPath = vscode.Uri.joinPath(currentDir!, item.newData.name).path;
					// do the rename
					if (originalPath && newPath) {
						await vscode.workspace.fs.rename(vscode.Uri.parse(originalPath), vscode.Uri.parse(newPath));

						pathToIdentifierMap.delete(originalPath);
						pathToIdentifierMap.set(newPath, identifier);
						identifierToPathMap.delete(identifier);
						identifierToPathMap.set(identifier, newPath);
					}
				}

				for (let [identifier, item] of movedIdentifiers) {
					let originalPath = getPathForIdentifier(identifier);
					let newPath = vscode.Uri.joinPath(currentDir!, item.newData.name).path;
					if (originalPath && newPath) {
						await vscode.workspace.fs.rename(vscode.Uri.parse(originalPath), vscode.Uri.parse(newPath));
						pathToIdentifierMap.delete(originalPath);
						pathToIdentifierMap.set(newPath, identifier);
						identifierToPathMap.delete(identifier);
						identifierToPathMap.set(identifier, newPath);
					}
				}
			}
		}

		let lines = content.split('\n');
		var modified = deletedIdentifiers.size > 0 || copiedIdentifiers.size > 0 || renamedIdentifiers.size > 0 || movedIdentifiers.size > 0;
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

		cutIdentifiers.clear();
	});

	const handleEnter = vscode.commands.registerCommand('vsoil.handleEnter', async () => {
		let currentCursorLineIndex = vscode.window.activeTextEditor?.selection.active.line;
		let prevDirectory = currentDir?.path;
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
				await updateDocContentToCurrentDir(prevDirectory);
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
			let a_name = a[0];
			let b_name = b[0];
			if (a[1] !== vscode.FileType.Directory){
				// remove extension from file name
				a_name = a_name.split('.').slice(0, -1).join('.');
				b_name = b_name.split('.').slice(0, -1).join('.');
			}

			if (a[1] === b[1]) {
				// compare file names. e.g. file1.txt should come before file10.txt even though lexicographically it should be the other way around
				return a_name.localeCompare(b_name, undefined, { numeric: true });

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

	let updateDocContentToCurrentDir = async (prevDirectory: string | undefined = undefined) => {

		let rootUri = currentDir;
		let content = await getContentForPath(rootUri!);
		let doc = await getVsoilDoc();

		if (prevDirectory){
			let prevContentOnDisk = await getContentForPath(vscode.Uri.parse(prevDirectory));
			let prevContentOnFile = doc.getText();

			let diskIdentifiers = new Set<string>();
			let fileIdentifiers = new Set<string>();

			for (let line of prevContentOnDisk.split('\n')){
				let { identifier } = parseLine(line);
				diskIdentifiers.add(identifier);
			}

			for (let line of prevContentOnFile.split('\n')){
				let { identifier } = parseLine(line);
				fileIdentifiers.add(identifier);
			}

			let cutIds = new Set([...diskIdentifiers].filter(x => !fileIdentifiers.has(x)));
			if (cutIds.size){
				cutIdentifiers = cutIds;
			}
		}

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

	context.subscriptions.push(
		vscode.window.onDidChangeTextEditorSelection(async (event) => {
			if (previewEnabled && event.textEditor.document === vsoilDoc) {
				let config = vscode.workspace.getConfiguration('vsoil');
				let previewExtensions = config.get<string[]>('previewExtensions') ?? [];
				let lineIndex = event.selections[0]?.active.line;
				if (lineIndex !== undefined) {
					let lineText = vsoilDoc.getText(vsoilDoc.lineAt(lineIndex).range);
					let { isDir, name } = parseLine(lineText);
					if (!isDir && name !== '..') {
						let ext = path.extname(name);
						if (previewExtensions.includes(ext)) {
							let fileUri = vscode.Uri.joinPath(currentDir!, name);
							let doc = await vscode.workspace.openTextDocument(fileUri);
							await vscode.window.showTextDocument(doc, {
								viewColumn: vscode.ViewColumn.Beside,
								preview: true,
								preserveFocus: true
							});
						}
						else{
							// show some general information, e.g. file size etc. in the preview window
							let fileUri = vscode.Uri.joinPath(currentDir!, name);
							let stats = await vscode.workspace.fs.stat(fileUri);
							let content = `Size:\t\t\t${getFileSizeHumanReadableName(stats.size)}\n`;
							content += `Modified:\t\t${new Date(stats.mtime).toLocaleString()}\n`;
							content += `Created:\t\t${new Date(stats.ctime).toLocaleString()}\n`;
							let doc = await getPreviewDoc();
							const edit = new vscode.WorkspaceEdit();
							const fullRange = new vscode.Range(
								doc.positionAt(0),
								doc.positionAt(doc.getText().length)
							);
							edit.replace(doc.uri, fullRange, content);
							await vscode.workspace.applyEdit(edit);
							await vscode.window.showTextDocument(doc, {
								viewColumn: vscode.ViewColumn.Beside,
								preview: true,
								preserveFocus: true
							});
						}
					}
					else{
						// show the directory listing in previewDoc
						let dirPath = vscode.Uri.joinPath(currentDir!, name);
						let content = await getContentForPath(dirPath);
						let doc = await getPreviewDoc();
						const edit = new vscode.WorkspaceEdit();
						const fullRange = new vscode.Range(
							doc.positionAt(0),
							doc.positionAt(doc.getText().length)
						);
						edit.replace(doc.uri, fullRange, content);
						await vscode.workspace.applyEdit(edit);
						await vscode.window.showTextDocument(doc, {
							viewColumn: vscode.ViewColumn.Beside,
							preview: true,
							preserveFocus: true
						});
					}
				}
			}
		})
	);
}

// This method is called when your extension is deactivated
export function deactivate() {}
