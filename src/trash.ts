import * as vscode from 'vscode';
import * as path from 'path';

import * as utils from './utils';

export function getTrashPathFromUri(uri: vscode.Uri, trashDir: vscode.Uri){
    // should return trashdir joined with the parent of uri
    let parentDir = path.dirname(uri.fsPath);
    return vscode.Uri.joinPath(trashDir, parentDir);
}

export async function saveToTrash(uri: vscode.Uri, trashDir: vscode.Uri){
    const sourcePath = uri.fsPath;
    
    // const sourceDir = path.dirname(sourcePath);
    const targetDir = getTrashPathFromUri(uri, trashDir);
    
    await vscode.workspace.fs.createDirectory(targetDir);
    
    const fileName = path.basename(sourcePath);
    const targetPath = vscode.Uri.joinPath(targetDir, fileName);
    
    await vscode.workspace.fs.copy(uri, targetPath, { overwrite: true });
}

export async function restoreFromTrash(uri: vscode.Uri, trashDir: vscode.Uri){
    // restore the file in uri from the trash directory if it exists
    const sourcePath = uri.fsPath;
    const targetDir = getTrashPathFromUri(uri, trashDir);
    const fileName = path.basename(sourcePath);
    const targetPath = vscode.Uri.joinPath(targetDir, fileName);
    try {
        await vscode.workspace.fs.copy(targetPath, uri, { overwrite: true });
        await vscode.workspace.fs.delete(targetPath);
    } catch (error) {
        console.error(`Failed to restore file from trash: ${error}`);
        throw error;
    }
}

export async function clearTrash(trashDir: vscode.Uri) {
    // clear all the files and directories in the trash directory
    try {
        const trashContents = await vscode.workspace.fs.readDirectory(trashDir);
        for (const [name, type] of trashContents) {
            const itemPath = vscode.Uri.joinPath(trashDir, name);
            if (type === vscode.FileType.Directory) {
                await vscode.workspace.fs.delete(itemPath, { recursive: true });
            } else {
                await vscode.workspace.fs.delete(itemPath);
            }
        }
    } catch (error) {
        console.error(`Failed to clear trash: ${error}`);
        throw error;
    }
}