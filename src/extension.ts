import * as vscode from 'vscode';
import * as path from 'path';

import * as utils from './utils';

const HEADER_LINES = 2;
const IDENTIFIER_SIZE = 7;
const METADATA_BEGIN_SYMBOL = "/[";
const METADATA_END_SYMBOL = "]/";
const PREVDIR_LINE = "../";
const ILLEGAL_FILE_NAMES_ON_WINDOWS = [
    "System Volume Information",
    "$RECYCLE.BIN",
    "DumpStack.log.tmp"
];


const MAX_RECURSIVE_DIR_LISTING_SIZE = 10000;
const IGNORED_DIRNAMES = [
    ".git",
]
let extensionDataDir: vscode.Uri | undefined = undefined;

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getFileNameFromUri(uri: vscode.Uri){
    let sep = path.sep;
    return uri.fsPath.split(sep).pop();
}

class CustomShellCommand{
    name: string;
    id: string;
    cmd: string;

    constructor(name: string, id: string, cmd: string){
        this.name = name;
        this.id = id;
        this.cmd = cmd;
    }

    async getInputs(){
        // match ${inp:input_name}
        let cmdWithInupts = this.cmd;
        let inputRegex = /\${inp:([^}]+)}/g;
        let inputNames = [];
        let match;
        while ((match = inputRegex.exec(this.cmd)) !== null) {
            inputNames.push(match[1]);
        }

        for (let inputName of inputNames){
            let input = await vscode.window.showInputBox({ prompt: `Enter value for ${inputName}` });
            if (input){
                cmdWithInupts = cmdWithInupts.replace(`\${inp:${inputName}}`, input);
            }
            else{
                return undefined;
            }
        }
        return cmdWithInupts;
    }
};

// global variables
var voilPanel: VoilDoc | undefined = undefined;
var voilDocs: VoilDoc[] = [];
var previewDoc: vscode.TextDocument | undefined = undefined;

var pathToIdentifierMap: Map<string, string> = new Map();
var identifierToPathMap: Map<string, string> = new Map();
var cutIdentifiers = new Set<string>();

let config = vscode.workspace.getConfiguration('voil');

let previewEnabled = config.get<boolean>('previewAutoOpen') ?? false;
let allowFocusOnIdentifier = config.get<boolean>('allowFocusOnIdentifier') ?? false;
let hideIdentifier = config.get<boolean>('hideIdentifier') ?? true;
let recursiveListingMaxDepth = config.get<number>('recursiveListingMaxDepth') ?? 10;
let customShellCommands_ = config.get<CustomShellCommand[]>('customShellCommands');
let trashDirectory = config.get<string>('trashDirectory') ?? "";
let customShellCommands = customShellCommands_?.map((cmd) => new CustomShellCommand(cmd.name, cmd.id, cmd.cmd));
var savedEditorLayout: SavedEditorLayout | undefined = undefined;

class DirectoryListingData {
    identifier: string;
    isDir: boolean;
    name: string;
    isNew: boolean;

    constructor(identifier: string, isDir: boolean, name: string, isNew: boolean=false) {
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
    deletedIdentifiers: Map<string, DirectoryListingData[]>,
    renamedIdentifiers: Map<string, RenamedDirectoryListingItem>,
    movedIdentifiers: Map<string, RenamedDirectoryListingItem>) {
    const panel = vscode.window.createWebviewPanel(
        'deleteConfirmation',
        'Delete Confirmation',
        vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
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

    let deletedItemsHtml = deletedIdentifiers.size > 0 ? `<h2>Deleted Items:</h2><ul>${deletedItemsList}</ul>` : '';
    let renamedItemsHtml = renamedIdentifiers.size > 0 ? `<h2>Renamed Items:</h2><ul>${renamedItemsList}</ul>` : '';
    let movedItemsHtml = movedIdentifiers.size > 0 ? `<h2>Moved Items:</h2><ul>${movedItemsList}</ul>` : '';
    panel.webview.html = `
        <html>
        <body>
            <h2>Are you sure you want to delete/rename/move the following files/directories?</h2>
            ${deletedItemsHtml}
            ${renamedItemsHtml}
            ${movedItemsHtml}
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
                window.addEventListener('keydown', (event) => {
                    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                        event.preventDefault();
                        document.getElementById('noButton').focus();
                    } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                        event.preventDefault();
                        document.getElementById('yesButton').focus();
                    }
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

type EditorLayout = {
  groups?: EditorLayoutGroup[];
  /* 0 - horizontal , 1 - vertical */
  orientation: 0 | 1;
};

type EditorLayoutGroup = {
  groups?: EditorLayoutGroup[];
  size: number;
};

type SavedEditorLayout = {
    layout: EditorLayout;
    visibleDocuments: vscode.TextDocument[];
};


enum SortBy {
    Name,
    FileType,
    Size,
    CreationDate
};

const parseLine = (line: string): DirectoryListingData => {
    if (line.endsWith("\r")) {
        line = line.slice(0, -1);
    }
    if (line.indexOf(METADATA_BEGIN_SYMBOL) !== -1) {
        // remove metadata
        let startIndex = line.indexOf(METADATA_BEGIN_SYMBOL);
        let endIndex = line.indexOf(METADATA_END_SYMBOL);
        line = line.slice(0, startIndex) + line.slice(endIndex + METADATA_END_SYMBOL.length);
    }
    if (line == PREVDIR_LINE) {
        return {
            identifier: "",
            isDir: true,
            name: "..",
            isNew: false
        };
    }

    // line begins with slash folllowed by identifier
    let regex = /^\/[A-Za-z]{7}/;
    let index = line.search(regex);
    let hasIdentifier = index >= 0;

    let parts = line.split(' ');
    if (hasIdentifier) {
        let identifier = parts[0].slice(1);
        let typeString = parts[1];
        let name = parts.slice(2).join(' ').trim();
        return {
            identifier: identifier,
            isDir: typeString === '/',
            name: name,
            isNew: false
        };
    }
    else {
        let name = line;
        let isDir = line.endsWith('/');
        return {
            identifier: '',
            isDir: isDir,
            name: name,
            isNew: !((name === '.') || name === '..')
        };

    }
};

const getCutIdentifiersFromFileContents = (prevContentOnDisk: string, prevContentOnFile: string) => {
    let diskIdentifiers = new Set<string>();
    let fileIdentifiers = new Set<string>();

    for (let line of prevContentOnDisk.split('\n')) {
        let { identifier } = parseLine(line);
        diskIdentifiers.add(identifier);
    }

    for (let line of prevContentOnFile.split('\n')) {
        let { identifier } = parseLine(line);
        fileIdentifiers.add(identifier);
    }

    let cutIds = new Set([...diskIdentifiers].filter(x => !fileIdentifiers.has(x)));
    return cutIds;
};

const updateCutIdentifiers = async (prevContentOnFile: string, prevContentOnDisk: string) => {

    let cutIds = getCutIdentifiersFromFileContents(prevContentOnDisk, prevContentOnFile);
    if (cutIds.size) {
        cutIdentifiers = cutIds;
    }
};

let updateDocContentToCurrentDir = async (doc: VoilDoc, prevDirectory: string | undefined = undefined, shouldClear: boolean = false) => {

    let rootUri = doc.currentDir;

    let prevContentOnFile = doc.doc.getText();
    let docTextEditor = doc.getTextEditor();

    if (shouldClear && docTextEditor){
        await docTextEditor.edit((editBuilder) => {
            editBuilder.replace(new vscode.Range(
                docTextEditor.document.positionAt(0),
                docTextEditor.document.positionAt(docTextEditor.document.getText().length)
            ), "loading ...");
        });
    }

    let prevContentOnDisk = doc.previousContent;
    let content = await doc.getContentForPath(rootUri!);

    if (prevDirectory) {
        // let prevContentOnDisk = await doc.getContentForPath(vscode.Uri.parse(prevDirectory));
        updateCutIdentifiers(prevContentOnFile, prevContentOnDisk);
    }

    // why do we do two different things here?
    // it is possible the the document doesn't have a text editor, so we need the second option for that case
    // however, that does not work very well when there are multiple simulataneous updates (e.g. when a lot of files are being copied)
    // so we have the first option as well
    if (docTextEditor) {
        await docTextEditor.edit((editBuilder) => {
            editBuilder.replace(new vscode.Range(
                docTextEditor.document.positionAt(0),
                docTextEditor.document.positionAt(docTextEditor.document.getText().length)
            ), content);
        });

        if (shouldClear){
            let line = doc.doc.lineAt(HEADER_LINES);
            let selection = new vscode.Selection(line.range.start, line.range.start);
            let editor = doc.getTextEditor();
            if (editor !== undefined) {
                editor.selection = selection;
            }
        }
    }
    else {

        // set doc content
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
            doc.doc.positionAt(0),
            doc.doc.positionAt(doc.doc.getText().length)
        );
        edit.replace(doc.doc.uri, fullRange, content);
        await vscode.workspace.applyEdit(edit);

    }
    if (hideIdentifier && docTextEditor) {
        setTimeout(() => {
            // the changes in vscode.workspace.applyEdit are not immediately reflected in the document
            // so we need to wait for a bit before applying the identifier decoration, this is a bit hacky
            // so if anyone knows a better way to do this, please let me know
            applyIdentifierDecoration(docTextEditor, docTextEditor.document);
        }, 50);
    }

};

const runShellCommand = (cmd: string, rootDir: string) => {
    const exec = require('child_process').exec;
    exec(cmd, { cwd: rootDir }, (error: any, stdout: any, stderr: any) => {
        if (error) {
            console.error(`exec error: ${error}`);
            return;
        }
        console.log(`stdout: ${stdout}`);
        console.error(`stderr: ${stderr}`);
    });
};

const fileNameSorter = (a: [string, vscode.FileType], b: [string, vscode.FileType]) => {
    let a_name = a[0];
    let b_name = b[0];
    if (a[1] !== vscode.FileType.Directory) {
        // remove extension from file name
        let a_parts = a_name.split('.');
        let b_parts = b_name.split('.');
        a_name = a_parts.length === 1 ? a_name : a_name.split('.').slice(0, -1).join('.');
        b_name = b_parts.length === 1 ? b_name : b_name.split('.').slice(0, -1).join('.');
    }

    if (a[1] === b[1]) {
        // compare file names. e.g. file1.txt should come before file10.txt even though lexicographically it should be the other way around
        return a_name.localeCompare(b_name, undefined, { numeric: true });

    }
    return a[1] === vscode.FileType.Directory ? -1 : 1;
};

let generateRandomString = (length: number) => {
    let result = '';
    let characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    let charactersLength = characters.length;
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
};

let getIdentifierForPath = (path: string) => {
    if (pathToIdentifierMap.has(path)) {
        return pathToIdentifierMap.get(path)!;
    }
    let identifier = generateRandomString(IDENTIFIER_SIZE);

    while (identifierToPathMap.has(identifier)) {
        identifier = generateRandomString(IDENTIFIER_SIZE);
    }

    pathToIdentifierMap.set(path, identifier);
    identifierToPathMap.set(identifier, path);
    return identifier;
}

const fileTypeSorter = (a: [string, vscode.FileType], b: [string, vscode.FileType]) => {
    if (a[1] === b[1] && (a[1] !== vscode.FileType.Directory)) {
        let aHasExt = a[0].includes('.');
        let bHasExt = b[0].includes('.');
        let aExt = aHasExt ? a[0].split('.').slice(-1)[0] : '';
        let bExt = bHasExt ? b[0].split('.').slice(-1)[0] : '';
        if (aExt === bExt) {
            return a[0].localeCompare(b[0]);
        }
        return aExt.localeCompare(bExt);
    }
    return fileNameSorter(a, b);
}

class VoilDoc {
    doc: vscode.TextDocument;
    hasPreview: boolean;
    currentDirectory: vscode.Uri;

    history: vscode.Uri[] = [];
    currentHistoryIndex: number = -1; 

    watcher: vscode.FileSystemWatcher | undefined;
    watcherHandleEventTimeout: NodeJS.Timeout | undefined = undefined;

    showFileSize: boolean = false;
    showFileCreationDate: boolean = false;
    sortBy: SortBy = SortBy.Name;
    isAscending: boolean = true;

    filterString: string = "";
    previousContent: string = "";

    creationEventSubscription : vscode.Disposable | undefined = undefined;
    deletionEventSubscription : vscode.Disposable | undefined = undefined;

    showRecursive: boolean = false;

    constructor(doc: vscode.TextDocument, hasPreview: boolean, currentDir: vscode.Uri) {
        this.doc = doc;
        this.hasPreview = hasPreview;
        this.currentDirectory = currentDir;
        this.updateWatcher();
    }

    cancelWatcherTimeout() {
        if (this.watcherHandleEventTimeout) {
            clearTimeout(this.watcherHandleEventTimeout);
        }
    }

    async toggleFileSize() {
        this.showFileSize = !this.showFileSize;
        await updateDocContentToCurrentDir(this);
    }

    async toggleCreationDate() {
        this.showFileCreationDate = !this.showFileCreationDate;
        await updateDocContentToCurrentDir(this);
    }

    async sortByFileType() {
        this.sortBy = SortBy.FileType;
        await updateDocContentToCurrentDir(this);
    }

    async sortByName() {
        this.sortBy = SortBy.Name;
        await updateDocContentToCurrentDir(this);
    }

    async sortByCreationTime() {
        this.sortBy = SortBy.CreationDate;
        await updateDocContentToCurrentDir(this);
    }

    async sortBySize() {
        this.sortBy = SortBy.Size;
        await updateDocContentToCurrentDir(this)
    }

    setFilterPattern(pattern: string) {
        this.filterString = pattern;
        updateStatusbar(this);
    }

    async toggleSortOrder() {
        this.isAscending = !this.isAscending;
        await updateDocContentToCurrentDir(this);
    }

    async focusOnLineWithContent(lineContent: string) {
        let docText = this.doc?.getText();
        let lineIndex = this.doc?.getText().split('\n').findIndex((line) => line.trimEnd().endsWith(` ${lineContent}`));
        if (lineIndex !== undefined && lineIndex !== -1) {
            let line = this.doc?.lineAt(lineIndex);
            if (line) {
                let selection = new vscode.Selection(line.range.start, line.range.start);
                if (vscode.window.activeTextEditor) {
                    vscode.window.activeTextEditor.selection = selection;
                    vscode.window.activeTextEditor.revealRange(new vscode.Range(selection.start, selection.end));
                }
            }
        }
    }


    resetWatcherTimeout() {
        // some filesystem changes can trigger onDidChange multiple times in quick succession
        // we want to wait for a bit before updating the document content, otherwise we might do
        // it multiple times in quick succession which causes some issues

        this.cancelWatcherTimeout();
        this.watcherHandleEventTimeout = setTimeout(async () => {
            await updateDocContentToCurrentDir(this);
        }, 100);
    }

    updateWatcher() {
        if (this.watcher) {
            this.watcher.dispose();
        }
        this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.currentDirectory.fsPath, '*'));
        this.enableWatcher();
    }

    disableWatcher(){

        if (this.deletionEventSubscription){
            this.deletionEventSubscription.dispose();
            this.creationEventSubscription?.dispose();
        }

        if (this.watcher){
            this.watcher.ignoreChangeEvents
            this.deletionEventSubscription = this.watcher.onDidDelete(async (e)=>{});
            this.creationEventSubscription = this.watcher.onDidCreate(async (e)=>{});
        }
    }

    enableWatcher(){

        if (this.deletionEventSubscription){
            this.deletionEventSubscription.dispose();
            this.creationEventSubscription?.dispose();
        }

        if (this.watcher){
            this.deletionEventSubscription = this.watcher.onDidDelete(async (e) => {
                this.resetWatcherTimeout();
            });
            this.creationEventSubscription = this.watcher.onDidCreate(async (e) => {
                this.resetWatcherTimeout();
            });
        }
    }

    getTextEditor() {
        return vscode.window.visibleTextEditors.find((editor) => editor.document === this.doc);
    }

    getFocusItem() {
        let editor = this.getTextEditor();
        let currentCursorLineIndex = editor?.selection.active.line;
        if (currentCursorLineIndex !== undefined) {
            return parseLine(this.doc.getText(this.doc.lineAt(currentCursorLineIndex).range));
        }
        return undefined;
    }


    getSelectedItems() {
        let editor = this.getTextEditor();
        let selectedItems: DirectoryListingData[] = [];
        if (editor) {
            for (let selection of editor.selections) {
                for (let i = selection.start.line; i <= selection.end.line; i++) {
                    let line = this.doc.getText(this.doc.lineAt(i).range);
                    let item = parseLine(line);
                    selectedItems.push(item);
                }
            }
        }
        return selectedItems;
    }

    runShellCommandOnSelectedItems(cmd: string) {
        // if the command contains ${file}, we run it for each selected file
        // if the command contains ${files}, we run it for all selected files at once

        let isBatch = cmd.includes('${files}') || cmd.includes('${filenames}');
        let items = this.getSelectedItems();
        let rootDir: string = this.currentDir.path;

        if (process.platform === "win32") {
            rootDir = rootDir.slice(1);
        }

        const mapFilenameToPath = (filename: string) => {
            let res = vscode.Uri.joinPath(this.currentDir!, filename).path;
            if (res[0] == "/" && (process.platform === "win32")) {
                res = res.slice(1);
            }
            return res;
        };

        if (isBatch) {
            let filesString = items.map(({ name }) => mapFilenameToPath(name)).join(' ');
            let fileNamesString = items.map(({ name }) => name).join(' ');

            let batchCmd = cmd.replace('${files}', filesString);
            batchCmd = batchCmd.replace('${filenames}', fileNamesString);
            runShellCommand(batchCmd, rootDir);
        }
        else {
            for (let { name } of items) {
                var fullPath = mapFilenameToPath(name);
                let commandToRun = cmd.replace('${file}', fullPath);
                commandToRun = commandToRun.replace('${filename}', name);
                runShellCommand(commandToRun, rootDir);
            }
        }
    }

    handleClose() {
        if (this.watcher) {
            this.watcher.dispose();
        }
    }

    get currentDir() {
        return this.currentDirectory;
    }

    set currentDir(uri: vscode.Uri) {
        this.currentDirectory = uri;

        if (this.currentHistoryIndex == -1 || this.history[this.currentHistoryIndex] != uri) {
            if (this.currentHistoryIndex < this.history.length - 1) {
                this.history = this.history.slice(0, this.currentHistoryIndex + 1);
                this.history.push(uri);
            }
            else {
                this.history.push(uri);
            }
            this.currentHistoryIndex = this.history.length - 1;
        }

        this.updateWatcher();
    }

    async goBack() {
        if (this.currentHistoryIndex > 0){
            this.currentHistoryIndex -= 1;
            this.currentDirectory = this.history[this.currentHistoryIndex];
            await updateDocContentToCurrentDir(this, this.history[this.currentHistoryIndex + 1].path);
        }
    }

    async goForward() {
        if (this.currentHistoryIndex < this.history.length - 1){
            this.currentHistoryIndex += 1;
            this.currentDirectory = this.history[this.currentHistoryIndex];
            await updateDocContentToCurrentDir(this, this.history[this.currentHistoryIndex - 1].path);
        }
    }

    async getFilesRecursive(rootUri: vscode.Uri, prefix: string = '', ignoredPatterns: RegExp[] = [], currentSize: number = 0, depth: number | undefined = undefined): Promise<[string, vscode.FileType][]> {
        if (depth == undefined){
            depth = recursiveListingMaxDepth;
        }

        let files = await vscode.workspace.fs.readDirectory(rootUri);
        let res: [string, vscode.FileType][] = [];
        let gitignoreFile = vscode.Uri.joinPath(rootUri, '.gitignore');
        if (await vscode.workspace.fs.stat(gitignoreFile).then(() => true, () => false)) {
            let gitignoreContent = (await vscode.workspace.fs.readFile(gitignoreFile)).toString();
            ignoredPatterns = ignoredPatterns.concat(
                gitignoreContent.split('\n')
                .filter((line) => line.trim().length > 0)
                .filter((line) => !line.startsWith("#"))
                .map((line) => utils.globToRegex(line.trim()))
            );
        }
        for (let [name, type] of files) {
            if (ignoredPatterns.some((pattern) => pattern.test(prefix + name))) {
                continue;
            }
            if (type === vscode.FileType.Directory) {
                if (IGNORED_DIRNAMES.includes(name)) {
                    continue;
                }

                if (depth > 0) {
                    let newPrefix = prefix + name + '/';
                    let subFiles = await this.getFilesRecursive(vscode.Uri.joinPath(rootUri, name), newPrefix, ignoredPatterns, currentSize, depth - 1);
                    res.push(...subFiles);
                    currentSize += subFiles.length;
                }
                else{
                    res.push([prefix + name, type]);
                    currentSize += 1;
                }
            }
            else {
                currentSize += 1;
                res.push([prefix + name, type]);
            }
            if (currentSize > MAX_RECURSIVE_DIR_LISTING_SIZE) {
                // maybe alert the user that the listing is too large
                break;
            }
        }
        return res;
    }



    async getContentForPath(rootUri: vscode.Uri, isPreview: boolean = false) {
        let files = await vscode.workspace.fs.readDirectory(rootUri!);
        if (!isPreview && this.showRecursive) {
            files = await this.getFilesRecursive(rootUri);
        }
        let currentPath = rootUri.path;
        let content = '';
        content += currentPath + "\n";

        let headerSeparator = '';
        for (let i = 0; i < currentPath.length; i++){
            headerSeparator += '=';
        }
        content += headerSeparator + "\n";

        let fileNameToMetadata: Map<string, string> = new Map();
        let fileNameToStats: Map<string, vscode.FileStat> = new Map();

        let needsMetaString = this.showFileSize || this.showFileCreationDate;
        let maxMetadataSize = 0;
        if (needsMetaString || this.sortBy === SortBy.Size || this.sortBy === SortBy.CreationDate) {
            for (let file of files) {
                let fullPath = vscode.Uri.joinPath(rootUri!, file[0]).path;
                if ((process.platform === "win32") && ILLEGAL_FILE_NAMES_ON_WINDOWS.includes(file[0])) {
                    continue;
                }
                let stats = await vscode.workspace.fs.stat(vscode.Uri.parse(fullPath));
                fileNameToStats.set(file[0], stats);

                if (needsMetaString) {
                    let metaString = '';
                    let numSeparators = 0;

                    const addSeparator = () => {
                        if (metaString.length > 0) {
                            metaString += '|';
                            numSeparators += 1;
                        }
                    };

                    if (this.showFileSize) {
                        let fileSizeString = utils.getFileSizeHumanReadableName(stats.size);
                        addSeparator();
                        metaString += fileSizeString;
                    }
                    if (this.showFileCreationDate) {
                        let fileDateString = new Date(stats.mtime).toLocaleDateString();
                        addSeparator();
                        metaString += fileDateString;

                    }
                    // let metaString = `${fileDateString}|${fileSizeString}`;
                    fileNameToMetadata.set(file[0], metaString);
                    let metaDataSize = IDENTIFIER_SIZE + 8 + numSeparators + metaString.length;
                    if (metaDataSize > maxMetadataSize) {
                        maxMetadataSize = metaDataSize;
                    }

                }
            }
        }


        let sorter = fileNameSorter;
        if (this.sortBy === SortBy.FileType) {
            sorter = fileTypeSorter;
        }
        if (this.sortBy === SortBy.CreationDate) {
            let statsSorter = (a: [string, vscode.FileType], b: [string, vscode.FileType]) => {
                let aStats = fileNameToStats.get(a[0]);
                let bStats = fileNameToStats.get(b[0]);
                if (aStats && bStats) {
                    return aStats.ctime - bStats.ctime;
                }
                return 0;
            };
            sorter = statsSorter;
        }
        if (this.sortBy === SortBy.Size) {
            let sizeSorter = (a: [string, vscode.FileType], b: [string, vscode.FileType]) => {
                let aStats = fileNameToStats.get(a[0]);
                let bStats = fileNameToStats.get(b[0]);
                if (aStats && bStats) {
                    return aStats.size - bStats.size;
                }
                return 0;
            };
            sorter = sizeSorter;
        }

        if (!this.isAscending) {
            let oldSorter = sorter;
            sorter = (a: [string, vscode.FileType], b: [string, vscode.FileType]) => -oldSorter(a, b);
        }

        // first show directories and then files
        files.sort(sorter);

        content += `${PREVDIR_LINE}\n`;
        for (let file of files) {

            // we don't want to filter the content of previews
            if (!isPreview) {
                if (this.filterString && !file[0].includes(this.filterString)) {
                    continue;
                }
            }

            let isDir = file[1] === vscode.FileType.Directory;
            let fullPath = vscode.Uri.joinPath(rootUri!, file[0]).path;
            let identifier = getIdentifierForPath(fullPath);
            let meta = '';
            if (this.showFileSize || this.showFileCreationDate) {
                meta = fileNameToMetadata.get(file[0]) ?? '';
                meta = METADATA_BEGIN_SYMBOL + meta + METADATA_END_SYMBOL;
            }

            let lineContent = '';
            if (isDir) {
                lineContent = `${identifier} / ${meta}`;
            }
            else {
                lineContent = `${identifier} - ${meta}`;
            }

            if (isPreview) {
                lineContent = '';
            }

            let dirPostfix = isDir ? '/' : '';
            // pad line content to maxMetadataSize
            lineContent = lineContent.padEnd(maxMetadataSize, ' ');
            content += `/${lineContent}${file[0]}${dirPostfix}\n`;
        }
        this.previousContent = content;
        return content;
    }
}

let filterStatusBarItem: vscode.StatusBarItem;

const hideIdentifierDecoration = vscode.window.createTextEditorDecorationType({
    textDecoration: 'none; font-size: 0pt',
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
});

const applyIdentifierDecoration = (editor: vscode.TextEditor, doc: vscode.TextDocument) => {
    let decorations: vscode.DecorationOptions[] = [];
    let renderOptions: vscode.DecorationRenderOptions = {
        after: {},
        dark: { after: {} },
        light: { after: {} },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    };

    for (let lineIndex = 0; lineIndex < doc.lineCount; lineIndex++) {
        if (lineIndex < HEADER_LINES) continue;
        let line = doc.lineAt(lineIndex);
        let lineText = line.text;
        let prefixSize = IDENTIFIER_SIZE + 4;
        let identifier = lineText.slice(0, prefixSize);
        if (identifier.length === prefixSize && identifier[0] === '/') {
            let identifierRange = new vscode.Range(line.range.start, line.range.start.translate(0, prefixSize));
            decorations.push({
                range: identifierRange,
                renderOptions: renderOptions
            });
        }
    }
    editor.setDecorations(hideIdentifierDecoration, decorations);
}

function updateStatusbar(voil: VoilDoc) {
    if (voil.filterString.length > 0) {
        filterStatusBarItem.text = `$(search) filter: ${voil.filterString}`;
        filterStatusBarItem.show();
    }
    else {
        filterStatusBarItem.hide();
    }
}

const saveCurrentEditorLayout = async () => {
    const layout = await vscode.commands.executeCommand('vscode.getEditorLayout') as EditorLayout;
    const visibleDocuments = vscode.window.visibleTextEditors.map((editor) => editor.document);
    savedEditorLayout = {
        layout: layout,
        visibleDocuments: visibleDocuments
    };

};

const restoreEditorLayout = async () => {
    if (savedEditorLayout) {
        await vscode.commands.executeCommand('vscode.setEditorLayout', savedEditorLayout.layout);
        let column = 1;
        let activeColumn = vscode.window.activeTextEditor?.viewColumn;
        let activeDocument = vscode.window.activeTextEditor?.document;
        for (let doc of savedEditorLayout.visibleDocuments) {
            if (column !== activeColumn) {
                await vscode.window.showTextDocument(doc, { viewColumn: column });
            }
            column += 1;
        }

        if (activeDocument) {
            await vscode.window.showTextDocument(activeDocument, { viewColumn: activeColumn });
        }
    }
};

const hidePreviewWindow = async () => {
    if (previewEnabled) {
        restoreEditorLayout();
    }
};

const closeNonVisibleVoilDocs = async () => {
    let docsToClose = [];
    if (voilPanel) {
        let isVisible = vscode.window.visibleTextEditors.some((editor) => editor.document === voilPanel?.doc);
        if (!isVisible) {
            docsToClose.push(voilPanel);
            voilPanel = undefined;
        }
    }
    let docsToKeep = [];
    for (let doc of voilDocs) {
        let isVisible = vscode.window.visibleTextEditors.some((editor) => editor.document === doc.doc);
        if (isVisible) {
            docsToKeep.push(doc);
        }
        else {
            docsToClose.push(doc);
        }
    }
    voilDocs = docsToKeep;
    for (let doc of docsToClose) {
        doc.handleClose();
        await vscode.window.showTextDocument(doc.doc).then(async () => {
            await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        });
    }
};

const getVoilDocForEditor = (activeEditor: vscode.TextEditor | undefined) => {
    if (activeEditor) {
        let doc = voilDocs.find((doc) => doc.doc === activeEditor?.document);
        if (doc) {
            return doc;
        }
    }
    if (voilPanel) {
        if (voilPanel.doc === activeEditor?.document) {
            return voilPanel;
        }
    }
    return undefined;
};

const getVoilDocForActiveEditor = async () => {
    let activeEditor = vscode.window.activeTextEditor;
    return getVoilDocForEditor(activeEditor);
}

let getVoilDoc = async () => {
    if (voilPanel) {
        return voilPanel;
    }
    let docUri = vscode.Uri.parse('untitled:Voil.voil');
    let doc = await vscode.workspace.openTextDocument(docUri);
    let res = new VoilDoc(doc, previewEnabled, vscode.workspace.workspaceFolders?.[0].uri!);
    voilPanel = res;
    return res;
};
    
let getCurrentUri = () => {
    let workspaceUri = vscode.workspace.workspaceFolders?.[0].uri;
    if (workspaceUri){
        return workspaceUri;
    }
    let fileUri = vscode.window.activeTextEditor?.document.uri;
    return fileUri
}

let newVoilDoc = async () => {
    let nonVisibleVoilDocs = voilDocs.filter((doc) => !vscode.window.visibleTextEditors.some((editor) => editor.document === doc.doc));
    if (nonVisibleVoilDocs.length > 0) {
        return nonVisibleVoilDocs[0];
    }

    let docUri = vscode.Uri.parse(`untitled:Voil-doc${voilDocs.length}.voil`);
    let usedDocNames = voilDocs.map((doc)=>getFileNameFromUri(doc.doc.uri));

    let newFileIndex: number = 0;
    let newFileName: string =  `Voil #${newFileIndex}.voil`;
    while (usedDocNames.includes(newFileName)){
        newFileIndex++;
        newFileName =  `Voil #${newFileIndex}.voil`;
    }

    if (extensionDataDir){
        docUri = vscode.Uri.joinPath(extensionDataDir, newFileName);
        await vscode.workspace.fs.writeFile(docUri, new Uint8Array());
    }

    let doc = await vscode.workspace.openTextDocument(docUri);
    // let res = new VoilDoc(doc, false, vscode.workspace.workspaceFolders?.[0].uri!);
    let res = new VoilDoc(doc, false, getCurrentUri()!);
    voilDocs.push(res);
    return res;
};

let getPreviewDoc = async () => {
    if (previewDoc) {
        return previewDoc;
    }
    previewDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse('untitled:Voil:preview.voil'));
    return previewDoc;
};

let getPathForIdentifier = (identifier: string) => {
    if (identifierToPathMap.has(identifier)) {
        return identifierToPathMap.get(identifier);
    }
    return '';
}

const focusOnFileWithName = async (voil: VoilDoc, name: string) => {
    let lineIndex = voil.doc.getText().split('\n').findIndex((line) => line.trimEnd().endsWith(name));
    if (lineIndex !== -1) {
        let line = voil.doc.lineAt(lineIndex);
        let selection = new vscode.Selection(line.range.start, line.range.start);
        if (vscode.window.activeTextEditor) {
            vscode.window.activeTextEditor.selection = selection;
            vscode.window.activeTextEditor.revealRange(new vscode.Range(selection.start, selection.end));
        }
    }
};

const getIdentifiersFromContent = (content: string) => {
    let res: Map<string, DirectoryListingData[]> = new Map();
    let lineIndex = 0;
    for (let line of content.split('\n')) {
        lineIndex++;
        if (lineIndex <= HEADER_LINES){
            continue;
        }

        if (line.trim().length === 0) {
            continue;
        }
        if (line.trim() === PREVDIR_LINE) {
            continue;
        }
        let { identifier, isDir, name, isNew } = parseLine(line);
        let oldList: DirectoryListingData[] = res.get(identifier) || [];
        oldList.push({ identifier, isDir, name, isNew });
        res.set(identifier, oldList);
    }
    return res;
};

const handleStartVoil = async (doc: VoilDoc, initialUri: vscode.Uri, fileToFocus: string | undefined = undefined) => {
    // doc.currentDir = vscode.workspace.workspaceFolders?.[0].uri!;
    doc.currentDir = initialUri;
    await updateDocContentToCurrentDir(doc);

    await vscode.window.showTextDocument(doc.doc);
    // move cursor to the first line
    let selection = new vscode.Selection(doc.doc.positionAt(HEADER_LINES), doc.doc.positionAt(HEADER_LINES));
    if (fileToFocus) {
        let lineIndex = doc.doc.getText().split('\n').findIndex((line) => line.trimEnd().endsWith(fileToFocus));
        if (lineIndex !== undefined && lineIndex !== -1) {
            let line = doc.doc.lineAt(lineIndex);
            selection = new vscode.Selection(line.range.start, line.range.start);
        }
    }

    if (vscode.window.activeTextEditor) {
        vscode.window.activeTextEditor.selection = selection;
        vscode.window.activeTextEditor.revealRange(new vscode.Range(selection.start, selection.end));
    }

    vscode.commands.executeCommand('setContext', 'voilDoc', true);
};

const getModificationsFromContentDiff = (doc: VoilDoc, oldContent: string, newContent: string) => {
    var originalIdentifiers: Map<string, DirectoryListingData[]> = getIdentifiersFromContent(oldContent);
    var newIdentifiers: Map<string, DirectoryListingData[]> = getIdentifiersFromContent(newContent);

    var copiedIdentifiers: Map<string, DirectoryListingData[]> = new Map();
    var movedIdentifiers: Map<string, RenamedDirectoryListingItem> = new Map();
    var renamedIdentifiers: Map<string, RenamedDirectoryListingItem> = new Map();
    var deletedIdentifiers: Map<string, DirectoryListingData[]> = new Map();

    for (let [identifier, items] of newIdentifiers) {
        let originalPath = getPathForIdentifier(identifier);
        let originalParentPath = utils.getPathParts(originalPath).slice(0, -1).join('/');
        // let isCurrentDirTheSameAsOriginal = doc.showRecursive || (doc.currentDir?.path === originalParentPath);
        let isCurrentDirTheSameAsOriginal = doc.showRecursive || utils.isSamePath(doc.currentDir?.path, originalParentPath);
        let newItems: DirectoryListingData[] = [];
        let originalExists = false;

        for (let item of items) {
            let itemName = item.name;
            if (item.isDir && itemName.endsWith("/")) {
                itemName = itemName.slice(0, -1);
            }
            let itemPath = vscode.Uri.joinPath(doc.currentDir!, itemName).path;
            if (originalPath && originalPath !== itemPath) {
                newItems.push(item);
            }
            else {
                originalExists = true;
            }
        }

        if (isCurrentDirTheSameAsOriginal) {

            if (!originalExists && newItems.length > 0 && originalPath) {
                renamedIdentifiers.set(identifier, new RenamedDirectoryListingItem(originalPath, newItems[0]));
                newItems = newItems.slice(1);
            }

            if (newItems.length > 0) {
                copiedIdentifiers.set(identifier, newItems);
            }
        }
        else {
            if (newItems.length > 0) {
                if (cutIdentifiers.has(identifier)) {
                    let firstItem = newItems[0];
                    let rest = newItems.slice(1);
                    movedIdentifiers.set(identifier, new RenamedDirectoryListingItem(originalPath!, firstItem));
                    if (rest.length > 0) {
                        copiedIdentifiers.set(identifier, rest);
                    }
                }
                else {
                    copiedIdentifiers.set(identifier, newItems);
                }
            }
        }
    }

    for (let [identifier, obj] of originalIdentifiers) {
        if (!newIdentifiers.has(identifier)) {
            deletedIdentifiers.set(identifier, obj);
        }
    }
    return { copiedIdentifiers, movedIdentifiers, renamedIdentifiers, deletedIdentifiers };
}

export function activate(context: vscode.ExtensionContext) {
    // var currentDir = vscode.workspace.workspaceFolders?.[0].uri;

    // update the settings when they change
    extensionDataDir = context.globalStorageUri;
    vscode.workspace.onDidChangeConfiguration((e) => {
        config = vscode.workspace.getConfiguration('voil');
        previewEnabled = config.get<boolean>('previewAutoOpen') ?? false;
        allowFocusOnIdentifier = config.get<boolean>('allowFocusOnIdentifier') ?? false;
        hideIdentifier = config.get<boolean>('hideIdentifier') ?? true;
        customShellCommands_ = config.get<CustomShellCommand[]>('customShellCommands');
        customShellCommands = customShellCommands_?.map((cmd) => new CustomShellCommand(cmd.name, cmd.id, cmd.cmd));
        trashDirectory = config.get<string>('trashDirectory') ?? "";
        recursiveListingMaxDepth = config.get<number>('recursiveListingMaxDepth') ?? 10;
    });

    const runShellCommandOnSelectionCommand = vscode.commands.registerCommand('voil.runShellCommandOnSelection', async () => {
        let shellCommand = await vscode.window.showInputBox({ prompt: 'Enter shell command to run on selected items' });
        if (shellCommand) {
            let voil = await getVoilDocForActiveEditor();
            if (voil !== undefined) {
                voil.runShellCommandOnSelectedItems(shellCommand)
            }
        }
    });

    const runShellCommandWithIdOnSelectionCommand = vscode.commands.registerCommand('voil.runShellCommandWithIdOnSelection', async (args) => {
        let cmdId = args.id;
        let cmd = customShellCommands?.find((cmd) => cmd.id === cmdId);
        let voil = await getVoilDocForActiveEditor();
        if (cmd && voil){
            let cmdWithInputs = await cmd.getInputs();
            if (cmdWithInputs){
                voil.runShellCommandOnSelectedItems(cmdWithInputs);
            }
        }
    });

    const toggleFileSizeCommand = vscode.commands.registerCommand('voil.toggleFileSize', async () => {
        let voil = await getVoilDocForActiveEditor();
        if (voil !== undefined){
            voil.toggleFileSize();
        }
    });

    let toggleCreationDateCommand = vscode.commands.registerCommand('voil.toggleCreationDate', async () => {
        let voil = await getVoilDocForActiveEditor();
        if (voil !== undefined){
            voil.toggleCreationDate();
        }
    });

    let sortByFileNameCommand = vscode.commands.registerCommand('voil.sortByFileName', async () => {
        let voil = await getVoilDocForActiveEditor();
        if (voil !== undefined){
            voil.sortByName();
        }
    });

    let sortByFileTypeCommand = vscode.commands.registerCommand('voil.sortByFileType', async () => {
        let voil = await getVoilDocForActiveEditor();
        if (voil !== undefined){
            voil.sortByFileType();
        }
    });

    let sortByCreationTimeCommand = vscode.commands.registerCommand('voil.sortByFileCreationTime', async () => {
        let voil = await getVoilDocForActiveEditor();
        if (voil !== undefined){
            voil.sortByCreationTime();
        }
    });

    let sortByFileSizeCommand = vscode.commands.registerCommand('voil.sortByFileSize', async () => {
        let voil = await getVoilDocForActiveEditor();
        if (voil !== undefined){
            voil.sortBySize();
        }
    });

    let toggleSortOrderCommand = vscode.commands.registerCommand('voil.toggleSortOrder', async () => {
        let voil = await getVoilDocForActiveEditor();
        if (voil !== undefined){
            voil.toggleSortOrder();
        }
    });


    const toggleRecursiveCommand = vscode.commands.registerCommand('voil.toggleRecursive', async () => {
        let voil = await getVoilDocForActiveEditor();
        if (voil){
            voil.showRecursive = !voil.showRecursive;
            await updateDocContentToCurrentDir(voil);
        }
    });

    const setFilterCommand = vscode.commands.registerCommand('voil.setFilter', async () => {
        let filterString = await vscode.window.showInputBox({ prompt: 'Enter filter pattern' });
        let voil = await getVoilDocForActiveEditor();
        if (voil && (filterString !== undefined)){
            voil.setFilterPattern(filterString);
            await updateDocContentToCurrentDir(voil);
        }
    });

    const gotoParentDirCommand = vscode.commands.registerCommand('voil.gotoParentDir', async () => {
        let voil = await getVoilDocForActiveEditor();
        if (voil){
            let parentDir = vscode.Uri.joinPath(voil.currentDir, '..');
            let currentDirectoryName = path.basename(voil.currentDir.path);
            voil.currentDir = parentDir;
            await updateDocContentToCurrentDir(voil);
            await voil.focusOnLineWithContent(currentDirectoryName + "/");
        }
    });
    

    const openCurrentDirectory = vscode.commands.registerCommand('voil.openCurrentDirectory', async () => {
        let doc = await getVoilDocForActiveEditor();
        if (doc) {
            // open the operating system's file explorer in the current directory
            vscode.env.openExternal(vscode.Uri.file(doc.currentDir.path));
        }
    });


    const handleSave = vscode.commands.registerCommand('voil.save', async () => {
        let doc = await getVoilDocForActiveEditor();
        if (!doc) return;

        // we don't want filesystem notifications for the changes we do ourselves
        doc.disableWatcher();
        let content = doc.doc.getText();
        let originalContent = doc.previousContent;

        // if (content !== doc.previousContent){
        //     originalContent = await doc.getContentForPath(doc.currentDir!);
        // }
        let currentTargetPath = content.split("\n")[0];
        let originalTargetPath = originalContent.split("\n")[0];
        if (currentTargetPath !== originalTargetPath){

            doc.currentDir = vscode.Uri.parse(currentTargetPath);
            await updateDocContentToCurrentDir(doc);
            doc.enableWatcher();
            return;
        }

        let { copiedIdentifiers, movedIdentifiers, renamedIdentifiers, deletedIdentifiers } = getModificationsFromContentDiff(doc, originalContent, content);


        let newNames : string[] = [];
        for (let [identifier, items] of copiedIdentifiers){
            let originalPath = getPathForIdentifier(identifier);
            for (let item of items){
                let newPath = vscode.Uri.joinPath(doc.currentDir!, item.name).path;
                if (originalPath){
                    await vscode.workspace.fs.copy(vscode.Uri.parse(originalPath), vscode.Uri.parse(newPath));

                    let newIdentifier = getIdentifierForPath(newPath);
                    pathToIdentifierMap.set(newPath, newIdentifier);
                    identifierToPathMap.set(newIdentifier, newPath);
                    newNames.push(item.name);
                }
            }
        }

        if (deletedIdentifiers.size > 0 || renamedIdentifiers.size > 0 || movedIdentifiers.size > 0){
            let response = await showDeleteConfirmation(deletedIdentifiers, renamedIdentifiers, movedIdentifiers);
            // make sure the document has focus
            await vscode.window.showTextDocument(doc.doc);
            if (response === 'Yes'){
                for (let [identifier, [{ isDir, name, isNew }]] of deletedIdentifiers){
                    // delete the file/directory
                    let path = getPathForIdentifier(identifier);
                    if (path){
                        if (trashDirectory.length > 0){
                            let uniqueName = name + '-' + Date.now();
                            if (isDir){
                                uniqueName = name.slice(0, -1) + '-' + Date.now() + '/';
                            }

                            let trashPath = vscode.Uri.joinPath(vscode.Uri.file(trashDirectory), uniqueName);
                            await vscode.workspace.fs.rename(vscode.Uri.parse(path), trashPath);
                        }
                        else{
                            if (isDir) {
                                await vscode.workspace.fs.delete(vscode.Uri.parse(path), { recursive: true });
                            }
                            else {
                                await vscode.workspace.fs.delete(vscode.Uri.parse(path));
                            }
                        }

                        pathToIdentifierMap.delete(path);
                        identifierToPathMap.delete(identifier);

                    }

                }
                for (let [identifier, item] of renamedIdentifiers) {
                    let originalPath = getPathForIdentifier(identifier);
                    let newPath = vscode.Uri.joinPath(doc.currentDir!, item.newData.name).path;
                    // do the rename
                    if (originalPath && newPath) {
                        await vscode.workspace.fs.rename(vscode.Uri.parse(originalPath), vscode.Uri.parse(newPath));

                        pathToIdentifierMap.delete(originalPath);
                        pathToIdentifierMap.set(newPath, identifier);
                        identifierToPathMap.delete(identifier);
                        identifierToPathMap.set(identifier, newPath);
                        newNames.push(item.newData.name);
                    }
                }

                for (let [identifier, item] of movedIdentifiers) {
                    let originalPath = getPathForIdentifier(identifier);
                    let newPath = vscode.Uri.joinPath(doc.currentDir!, item.newData.name).path;
                    if (originalPath && newPath) {
                        await vscode.workspace.fs.rename(vscode.Uri.parse(originalPath), vscode.Uri.parse(newPath));
                        pathToIdentifierMap.delete(originalPath);
                        pathToIdentifierMap.set(newPath, identifier);
                        identifierToPathMap.delete(identifier);
                        identifierToPathMap.set(identifier, newPath);
                        newNames.push(item.newData.name);
                    }
                }
            }
            else{
                // if the user chose "No", then we update the contents of the documents because the user might have made some changes 
                // for example, if the user has deleted some files from a view and then chose "No", we should restore the view to its original state
                for (let doc of voilDocs){
                    await updateDocContentToCurrentDir(doc);
                }
            }
        }

        let lines = content.split('\n');
        var modified = deletedIdentifiers.size > 0 || copiedIdentifiers.size > 0 || renamedIdentifiers.size > 0 || movedIdentifiers.size > 0;
        let lineIndex = 0;
        for (let line of lines){
            lineIndex++;
            if (lineIndex <= HEADER_LINES) continue;

            if (line.trim().length === 0) {
                continue;
            }

            let { identifier, isDir, name, isNew } = parseLine(line);
            if (isNew) {
                if (isDir) {
                    let fullPath = vscode.Uri.joinPath(doc.currentDir!, name + "/");
                    await vscode.workspace.fs.createDirectory(fullPath);
                    newNames.push(name);
                    modified = true;
                }
                else {
                    let fullPath = vscode.Uri.joinPath(doc.currentDir!, name);
                    await vscode.workspace.fs.writeFile(fullPath, new Uint8Array());
                    newNames.push(name);
                    modified = true;
                }
            }
        }

        if (modified){
            await updateDocContentToCurrentDir(doc);
            if (newNames.length > 0){
                let focusString = newNames[0];
                if (!doc.showRecursive){
                    let nameParts = utils.getPathParts(newNames[0]);
                    let firstPathPart = utils.getPathParts(newNames[0])[0];
                    if (nameParts.length > 1 || newNames[0].endsWith('/')){
                        firstPathPart = firstPathPart + '/';
                    }
                    focusString = firstPathPart; 
                }
                focusOnFileWithName(doc, focusString);
            }
        }

        cutIdentifiers.clear();
        doc.enableWatcher();
    });

    const handleCd = vscode.commands.registerCommand('voil.cd', async () => {
        let voil = await getVoilDocForActiveEditor();
        if (voil){
            let dir = await vscode.window.showInputBox({ prompt: 'Enter directory to go to' });
            if (dir){
                let targetDir = dir;

                if ("win32" === process.platform){
                    targetDir = '/' + dir;
                }
                else{
                    if (targetDir.startsWith("~")){
                        let homedir = process.env.HOME;
                        targetDir = homedir + targetDir.slice(1);
                    }
                }

                let oldDir = voil.currentDir;
                try{
                    voil.currentDir = vscode.Uri.parse(targetDir);
                    await updateDocContentToCurrentDir(voil);
                }
                catch (e){
                    voil.currentDir = oldDir;
                    await vscode.window.showErrorMessage("Invalid directory");
                    await updateDocContentToCurrentDir(voil);
                }
            }
        }
    });

    const handleClose = vscode.commands.registerCommand('voil.close', async () => {
        // close the voil window
        let doc = await getVoilDocForActiveEditor();
        if (doc){

            if (doc.watcher){
                doc.watcher.dispose();
            }

            // remove doc from vsoilDocs
            voilDocs = voilDocs.filter((d) => d !== doc);
            await vscode.window.showTextDocument(doc.doc).then(async () => {
                await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
            });
        }
    });

    const handlePreview = vscode.commands.registerCommand('voil.preview', async () => {
        let doc = await getVoilDocForActiveEditor();
        let line = vscode.window.activeTextEditor?.selection.active.line;
        let lineContent = vscode.window.activeTextEditor?.document.getText(new vscode.Range(line!, 0, line!, 100));
        let {identifier, isDir, name} = parseLine(lineContent ?? '');
        let path = getPathForIdentifier(identifier);
        if (path){
            vscode.window.showTextDocument(vscode.Uri.parse(path), { preview: true, viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
        }
    });

    const handleEnter = vscode.commands.registerCommand('voil.enter', async () => {
        let doc = await getVoilDocForActiveEditor();
        if (!doc) return;

        // disable recursive listing when chaging documents
        // for example going to a large parent document while recursive
        // listing is enabled can cause performance problems, if the user
        // really needs recursive listing they can re-enable it
        doc.showRecursive = false;

        // let activeEditor = doc.getTextEditor();
        let currentCursorLineIndex = vscode.window.activeTextEditor?.selection.active.line;
        let prevDirectory = doc.currentDir?.path;
        if (currentCursorLineIndex !== undefined) {
            if (currentCursorLineIndex < HEADER_LINES){
                // when we press enter on the current path at the top, open it in the file explorer
                if (currentCursorLineIndex == 0){
                    vscode.env.openExternal(vscode.Uri.file(doc.currentDir.path));
                }
                return;
            }
            let {identifier, isDir, name} = parseLine(doc.doc.getText(doc.doc.lineAt(currentCursorLineIndex).range) ?? '');
            let currentDirName = name;
            var focusLine = '';

            if (isDir){
                doc.filterString = '';
                if (currentDirName === '..') {
                    // focusline should be the last part of current path
                    let pathParts = utils.getPathParts(doc.currentDir?.path);
                    focusLine = pathParts?.[pathParts.length - 1] ?? '';
                    doc.currentDir = vscode.Uri.joinPath(doc.currentDir!, '..');
                }
                else {
                    doc.currentDir = vscode.Uri.joinPath(doc.currentDir!, currentDirName!);
                    if (vscode.window.activeTextEditor) {
                        let line = doc.doc?.lineAt(HEADER_LINES);
                        let selection = new vscode.Selection(line.range.start, line.range.start);
                        vscode.window.activeTextEditor.selection = selection;
                        vscode.window.activeTextEditor.revealRange(new vscode.Range(HEADER_LINES, 0, 0, 0));
                    }
                }
                await updateDocContentToCurrentDir(doc, prevDirectory, true);
                if (focusLine){
                    doc.focusOnLineWithContent(focusLine + "/");
                }
            }
            else{
                // open file
                let fileUri = vscode.Uri.joinPath(doc.currentDir!, currentDirName!);
                let newdoc = await vscode.workspace.openTextDocument(fileUri);

                // if we don't close the voil windows, vscode will show an annoying "do you want to save changes" dialog
                voilDocs = voilDocs.filter((d) => d !== doc);
                doc.handleClose();
                await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
                
                await vscode.window.showTextDocument(newdoc);
                if (doc.hasPreview){
                    await hidePreviewWindow();
                }
            }
        }

    });

    const openVoilDoc = vscode.commands.registerCommand('voil.openPanel', async () => {
        let doc = await newVoilDoc();
        await handleStartVoil(doc, vscode.workspace.workspaceFolders?.[0].uri!);
    });

    const startVoilCommand = vscode.commands.registerCommand('voil.openPanelWithPreview', async () => {

        await saveCurrentEditorLayout();
        let doc = await getVoilDoc();
        await handleStartVoil(doc, vscode.workspace.workspaceFolders?.[0].uri!);

    });


    const openVoilDocCurrentDir = vscode.commands.registerCommand('voil.openPanelCurrentDir', async () => {
        let doc = await newVoilDoc();
        let currentDocumentPath = vscode.window.activeTextEditor?.document.uri;
        let parentUri = vscode.workspace.workspaceFolders?.[0].uri!;
        let currentDocumentName = undefined;
        if (currentDocumentPath){
            if (!currentDocumentPath.toString().endsWith(".voil")){
                currentDocumentName = path.basename(currentDocumentPath.path);
                parentUri = vscode.Uri.joinPath(currentDocumentPath!, '..');
            }
        }

        await handleStartVoil(doc, parentUri, currentDocumentName);
    });

    const startVoilCommandCurrentDir = vscode.commands.registerCommand('voil.openPanelWithPreviewCurrentDir', async () => {

        await saveCurrentEditorLayout();
        let currentDocumentPath = vscode.window.activeTextEditor?.document.uri;
        let parentUri = vscode.workspace.workspaceFolders?.[0].uri!;
        let currentDocumentName = undefined;
        if (currentDocumentPath){
            if (!currentDocumentPath.toString().endsWith(".voil")){
                currentDocumentName = path.basename(currentDocumentPath.path);
                parentUri = vscode.Uri.joinPath(currentDocumentPath!, '..');
            }
        }
        let doc = await getVoilDoc();
        await handleStartVoil(doc, parentUri, currentDocumentName);

    });

    const voilPreviousCommand = vscode.commands.registerCommand('voil.previous', async () => {
        let doc = await getVoilDocForActiveEditor();
        doc?.goBack();
    });

    const voilNextCommand = vscode.commands.registerCommand('voil.next', async () => {
        let doc = await getVoilDocForActiveEditor();
        doc?.goForward();
    });



    let lastFocusedEditor: vscode.TextEditor | undefined = undefined;

    context.subscriptions.push(handleSave);
    context.subscriptions.push(handleEnter);
    context.subscriptions.push(handlePreview);
    context.subscriptions.push(handleClose);
    context.subscriptions.push(openVoilDoc);
    context.subscriptions.push(startVoilCommand);
    context.subscriptions.push(startVoilCommandCurrentDir);
    context.subscriptions.push(openVoilDocCurrentDir);
    context.subscriptions.push(runShellCommandOnSelectionCommand);
    context.subscriptions.push(runShellCommandWithIdOnSelectionCommand);
    context.subscriptions.push(toggleFileSizeCommand);
    context.subscriptions.push(toggleCreationDateCommand);
    context.subscriptions.push(sortByFileNameCommand);
    context.subscriptions.push(sortByCreationTimeCommand);
    context.subscriptions.push(sortByFileTypeCommand);
    context.subscriptions.push(sortByFileSizeCommand);
    context.subscriptions.push(toggleSortOrderCommand);
    context.subscriptions.push(toggleRecursiveCommand);
    context.subscriptions.push(setFilterCommand);
    context.subscriptions.push(gotoParentDirCommand);
    context.subscriptions.push(openCurrentDirectory);
    context.subscriptions.push(voilPreviousCommand);
    context.subscriptions.push(voilNextCommand);

    context.subscriptions.push(
        vscode.workspace.onWillSaveTextDocument(async (event: vscode.TextDocumentWillSaveEvent) => {
            await vscode.commands.executeCommand('voil.save');
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(async (doc) => {
            if (doc.uri.fsPath.endsWith('.voil')) {
                let voil = voilDocs.find((v) => v.doc === doc);
                if (voil) {
                    voilDocs = voilDocs.filter((v) => v !== voil);
                    if (voil.watcher){
                        voil.watcher.dispose();
                    }
                }
            }
        })
    );
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async (editor) => {

            vscode.commands.executeCommand('setContext', 'voilDoc', editor?.document.uri.fsPath.endsWith('.voil'));

            // when active editor changes, update the cut identifiers
            // this is to enable cutting between different voil panels
            // for example, in a two panel layout, if you cut a file in one panel and paste it in another panel
            // we need to have updated cut identifiers in the old panel when we switch to the new panel
            let prevEditor = lastFocusedEditor;
            lastFocusedEditor = editor;
            if (prevEditor && prevEditor.document.uri.fsPath.endsWith('.voil')) {
                let doc = await getVoilDocForEditor(prevEditor);
                if (doc) {
                    let prevDirectory = doc.currentDir?.path;
                    // let prevListingContent = await doc.getContentForPath(vscode.Uri.parse(prevDirectory!));
                    let prevListingContent = doc.previousContent;
                    updateCutIdentifiers(doc.doc.getText(), prevListingContent);
                }
            }

            // update the statusbar item
            let doc = await getVoilDocForEditor(editor);
            if (doc) {
                updateStatusbar(doc);
            } else {
                filterStatusBarItem.hide();
            }

            let isPreviewWindow = editor?.document.uri.fsPath.endsWith(':preview.voil');
            if (!isPreviewWindow && hideIdentifier && (doc !== undefined) && (editor !== undefined)) {
                applyIdentifierDecoration(editor, editor.document);
            }

        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(async (event) => {
            if (hideIdentifier && (event.document === vscode.window.activeTextEditor?.document)){
                let isVoil = event.document.uri.fsPath.endsWith('.voil') && !event.document.uri.fsPath.endsWith(':preview.voil');
                if (isVoil){
                    applyIdentifierDecoration(vscode.window.activeTextEditor, event.document);
                }
            }
        })
    );

    const LISTING_PREFIX_SIZE = IDENTIFIER_SIZE + 4; 
    const LISTING_REGEX = new RegExp('^\\/[a-zA-Z]{7} [-/] ');

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(async (event) => {
            if (!event.textEditor.document.uri.fsPath.endsWith('.voil')) {
                return;
            }

            let doc = await getVoilDocForActiveEditor();
            if (doc == undefined) return;

            // if there is no text selection
            if (!allowFocusOnIdentifier){
                if (event.selections.length === 1 && event.selections[0].start.line === event.selections[0].end.line && event.selections[0].start.character === event.selections[0].end.character) {
                    let startsWithListingRegex = LISTING_REGEX.test(event.textEditor.document.lineAt(event.selections[0].start.line).text);
                    if (startsWithListingRegex) {
                        // make sure that the cursor can not be before LISTING_PREFIX_SIZE
                        if (event.selections[0].active.character < LISTING_PREFIX_SIZE) {
                            let newPosition = event.selections[0].active.with({ character: LISTING_PREFIX_SIZE });
                            event.textEditor.selection = new vscode.Selection(newPosition, newPosition);
                            return;
                        }
                    }
                }
            }

            if (doc.hasPreview === false) return;

            // when selection changes, update the preview window
            if (previewEnabled && event.textEditor.document === doc.doc) {
                let previewExtensions = config.get<string[]>('previewExtensions') ?? [];
                let lineIndex = event.selections[0]?.active.line;
                if (lineIndex !== undefined) {
                    let lineText = doc.doc.getText(doc.doc.lineAt(lineIndex).range)
                    let { isDir, name } = parseLine(lineText);
                    if (!isDir && name !== '..') {
                        let ext = path.extname(name);
                        if (previewExtensions.includes(ext)) {
                            let fileUri = vscode.Uri.joinPath(doc.currentDir!, name);
                            let newdoc = await vscode.workspace.openTextDocument(fileUri);
                            await vscode.window.showTextDocument(newdoc, {
                                viewColumn: vscode.ViewColumn.Beside,
                                preview: true,
                                preserveFocus: true
                            });
                        }
                        else{
                            // show some general information, e.g. file size etc. in the preview window
                            let fileUri = vscode.Uri.joinPath(doc.currentDir!, name);
                            let stats = await vscode.workspace.fs.stat(fileUri);
                            let content = `Size:\t\t\t${utils.getFileSizeHumanReadableName(stats.size)}\n`;
                            content += `Modified:\t\t${new Date(stats.mtime).toLocaleString()}\n`;
                            content += `Created:\t\t${new Date(stats.ctime).toLocaleString()}\n`;
                            let newdoc = await getPreviewDoc();
                            const edit = new vscode.WorkspaceEdit();
                            const fullRange = new vscode.Range(
                                newdoc.positionAt(0),
                                newdoc.positionAt(newdoc.getText().length)
                            );
                            edit.replace(newdoc.uri, fullRange, content);
                            await vscode.workspace.applyEdit(edit);
                            await vscode.window.showTextDocument(newdoc, {
                                viewColumn: vscode.ViewColumn.Beside,
                                preview: true,
                                preserveFocus: true
                            });
                        }
                    }
                    else{
                        // show the directory listing in previewDoc
                        let dirPath = vscode.Uri.joinPath(doc.currentDir!, name);
                        let content = await doc.getContentForPath(dirPath, true);
                        let newdoc = await getPreviewDoc();
                        const edit = new vscode.WorkspaceEdit();
                        const fullRange = new vscode.Range(
                            newdoc.positionAt(0),
                            newdoc.positionAt(newdoc.getText().length)
                        );
                        edit.replace(newdoc.uri, fullRange, content);
                        await vscode.workspace.applyEdit(edit);
                        await vscode.window.showTextDocument(newdoc, {
                            viewColumn: vscode.ViewColumn.Beside,
                            preview: true,
                            preserveFocus: true
                        });
                    }
                }
            }
        })
    );

    filterStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    filterStatusBarItem.text = "$(search) filter: (none)";
    // filterStatusBarItem.show();
}

// This method is called when your extension is deactivated
export function deactivate() {}
