# Zetta Utils CUE Support

A VS Code extension providing intelligent language server support for CUE files in the Zetta Utils ecosystem. Features smart auto-completion, hover documentation, parameter validation, and builder templates.

## Key Features

- ** Smart Auto-Completion**: Intelligent completion for zetta_utils builders and parameters
- ** Hover Documentation**: Detailed parameter descriptions from Python docstrings with source links
- ** Parameter Validation**: Real-time validation with helpful error messages and suggestions
- ** Builder Templates**: Complete templates for complex builders with proper structure
- ** Version-Aware**: Handles multiple builder versions with semantic version matching

## Quick Start

### Prerequisites
1. **Install Python extension** for VS Code (ms-python.python)
2. **Select Python interpreter** with zetta_utils installed
3. **Install CUE extension** for syntax highlighting (optional but recommended)

### Installation
1. Run `./setup.sh` to build the extension
2. Install via **Ctrl/Cmd+Shift+P** → "Developer: Install Extension from Location..."
3. Select the extension folder

### Basic Usage
1. **Open a .cue file** in a workspace containing zetta_utils
2. **Hover over parameters** to see documentation
3. **Use auto-completion** for builder names and parameters
4. **Check validation errors** for parameter issues

## Available Commands

- **Refresh Builder Metadata**: Updates builder information from zetta_utils
- **Select Python Interpreter**: Choose Python environment with zetta_utils installed

## Configuration

Access via **File > Preferences > Settings** → search "Zetta Utils":

- `zettatUtilsCue.enableAutocomplete`: Enable/disable auto-completion (default: true)
- `zettatUtilsCue.enableValidation`: Enable/disable parameter validation (default: true)
- `zettatUtilsCue.metadataPath`: Custom metadata file path (leave empty for auto-generated)

## Development

### Architecture
- **Language Server Protocol (LSP)** implementation using TypeScript
- **Go CUE parser** for accurate AST-based parsing and context detection
- **Python metadata extraction** from zetta_utils source code
- **Modular design** with separate files for completion, validation, hover, and parsing

## Requirements

- **VS Code** 1.74.0 or newer
- **Python extension** (ms-python.python)
- **Go** and **CUE** (for building the extension)
- **Node.js** (for building the extension)

## Troubleshooting

### Extension Not Working
1. **Check Python interpreter**: Ensure it has zetta_utils installed
2. **Refresh metadata**: Use command palette → "Refresh Builder Metadata"
3. **Check file extension**: Make sure file has `.cue` extension
4. **Check output panel**: View → Output → "Zetta Utils CUE Language Server"

### No Syntax Highlighting
1. **Install CUE extension**: Search for "CUE" in Extensions marketplace
2. **File association**: Ensure `.cue` files are associated with CUE language
