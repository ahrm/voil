# Voil

Edit file system like a text buffer (similar to [oil.nvim](https://github.com/stevearc/oil.nvim)). Create new files/directories by typing their names in the editor (names ending with `/` are treated as directories). Convert your existing text-editing skills to file system manipulation skills, as opposed of the vscode's default file explorer which requires mouse interaction or memorizing new keybinds (and still is nowhere near as powerful). Demo:

https://github.com/user-attachments/assets/2a04bff7-1c10-45ee-bf02-dd814a08a142

View on the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=AliMostafavi.voil).

## How it works
There is a hidden ID associated with each file which is how voil determines which file is being e.g. renamed or moved. This ID is normally hidden using vscode's decorations but you can show them by setting the following configs:
```
"voil.hideIdentifier": false,
"voil.allowFocusOnIdentifier": true
```

If you e.g. want to copy or move a file you must make sure to use commands that also copy the identifier and not just the visible part (that is, commands that select entire lines and not words).

## Example keybind configuration
### for normal users
Uses `ctrl+shift+b` to open the voil panel and if we are already in voil navigates to the parent directory.
```
{
    "key": "ctrl+shift+b",
    "command": "voil.openPanelCurrentDir",
    "when": "!voilDoc"
},
{
    "key": "ctrl+shift+b",
    "command": "voil.gotoParentDir",
    "when": "voilDoc && editorFocus"
}
```
### for users with Vim extension
Uses `-` key in normal mode to open the voil panel and if we are already in voil navigates to the parent directory.
```
{
    "key": "-",
    "command": "voil.openPanelCurrentDir",
    "when": "!voilDoc && vim.mode == 'Normal' && editorFocus"
},
{
    "key": "-",
    "command": "voil.gotoParentDir",
    "when": "voilDoc && vim.mode == 'Normal' && editorFocus"
}
```

## Command List
### `voil.openPanel`
**Title:** voil: Open voil panel at workspace root  
**Description:** Opens the voil panel at the root of the workspace.

### `voil.openPanelCurrentDir`
**Title:** voil: Open voil panel at current directory  
**Description:** Opens the voil panel at the current directory.

### `voil.toggleRecursive`
**Title:** voil: Toggle recursive listing  
**Description:** Toggles the recursive listing of files and directories.

### `voil.gotoParentDir`
**Title:** voil: Go to parent directory  
**Description:** Navigates to the parent directory.

### `voil.setFilter`
**Title:** voil: Filter files  
**Description:** Sets a filter to display specific files.

### `voil.toggleFileSize`
**Title:** voil: toggle file size  
**Description:** Toggles the display of file sizes.

### `voil.toggleCreationDate`
**Title:** voil: toggle file creation date  
**Description:** Toggles the display of file creation dates.

### `voil.sortByFileName`
**Title:** voil: sort by file name  
**Description:** Sorts the files by their names.

### `voil.enter`
**Title:** voil: Enter the current selected item.  
**Description:** Enters the currently selected item.

### `voil.preview`
**Title:** voil: Open a preview to current selected item.  
**Description:** Opens a preview of the currently selected item.

### `voil.close`
**Title:** voil: Close the voil window.  
**Description:** Closes the voil window.

### `voil.save`
**Title:** voil: Apply the changes to filesystem.  
**Description:** Saves and applies the changes to the filesystem.

### `voil.sortByFileType`
**Title:** voil: sort by file type  
**Description:** Sorts the files by their types.

### `voil.sortByFileCreationTime`
**Title:** voil: sort by file creation time  
**Description:** Sorts the files by their creation times.

### `voil.sortByFileSize`
**Title:** voil: sort by file size  
**Description:** Sorts the files by their sizes.

### `voil.toggleSortOrder`
**Title:** voil: toggle sort order  
**Description:** Toggles the sort order of the files.

### `voil.cd`
**Title:** voil: set the current directory  
**Description:** Sets the current directory.

### `voil.runShellCommandOnSelection`
**Title:** voil: run shell command on selected items  
**Description:** Runs a shell command on the selected items.

### `voil.openCurrentDirectory`
**Title:** voil: Open the current directory in the default file explorer  
**Description:** Opens the current directory in the default file explorer.

## Custom shell commands

You can define custom shell commands to be executed on the selected items. The following special variables will be expanded in the command:
- `${file}` expands to the full path of the selected file
- `${filename}` expands just to the name of the selected file 
- `${files}` expands to the space-separated list of full paths of the selected files
- `${filenames}` expands to the space-separated list of names of the selected files
- `${inp:inputname}` prompts the user for input with the given name

If the command includes `${file}` or `${filename}` the command will be executed for each selected file (so if 10 files are selected, the command will be executed 10 times). If the command includes `${files}` or `${filenames}` the command will be executed once with all selected files.

For example here is how to configure `zip` and `unzip` commands:
```
"voil.customShellCommands": [
    {
        "name": "Zip",
        "id": "zip",
        "cmd": "zip ${inp:compressedname}.zip ${filenames}"
    },
    {
        "name": "Unzip",
        "id": "unzip",
        "cmd": "unzip ${file}"
    },
],
```
And here is how to bind them to keybindings in `keybindings.json`:
```
{
    "key": "ctrl+f1",
    "command": "voil.runShellCommandWithIdOnSelection",
    "args": {
        "id": "unzip"
    },
    "when": "voilDoc"
},
{
    "key": "ctrl+f2",
    "command": "voil.runShellCommandWithIdOnSelection",
    "args": {
        "id": "zip"
    },
    "when": "voilDoc"
}
```

## Donation
If you enjoy voil, please consider donating to support its development.

<a href="https://www.buymeacoffee.com/ahrm" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/default-orange.png" alt="Buy Me A Coffee" height="41" width="174"></a>
