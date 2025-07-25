#!/bin/bash

echo "🚀 Setting up Zetta Utils CUE VSCode Extension..."
echo ""

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: package.json not found. Please run this script from the vscode-zutils directory."
    exit 1
fi

# Check prerequisites
echo "🔍 Checking prerequisites..."

# Check Node.js/npm
if ! command -v npm &> /dev/null; then
    echo "❌ Error: npm is not installed. Please install Node.js and npm."
    exit 1
fi

# Check Go
if ! command -v go &> /dev/null; then
    echo "❌ Error: go is not installed. Please install Go."
    exit 1
fi

# Check CUE
if ! command -v cue &> /dev/null; then
    echo "❌ Error: cue is not installed. Please install CUE."
    exit 1
fi

echo "✅ Prerequisites check passed!"
echo ""

# Install npm dependencies
echo "📦 Installing npm dependencies..."
if ! npm install; then
    echo "❌ Error: Failed to install npm dependencies."
    exit 1
fi
echo "✅ npm dependencies installed!"
echo ""

# Build Go parser
echo "🔨 Building Go CUE parser..."
cd scripts/cue-parser
if ! go build -o cue-parser main.go; then
    echo "❌ Error: Failed to build Go parser."
    exit 1
fi
cd ../..
echo "✅ Go parser built successfully!"
echo ""

# Compile TypeScript
echo "⚙️  Compiling TypeScript..."
if ! npm run compile; then
    echo "❌ Error: Failed to compile TypeScript."
    exit 1
fi
echo "✅ TypeScript compiled successfully!"
echo ""

echo "🎉 Setup complete!"
echo ""
echo "📋 Next steps:"
echo "1. Install this extension:"
echo "   - Ctrl/Cmd+Shift+P → 'Developer: Install Extension from Location...'"
echo "   - Select this folder"
echo ""
echo "2. Install CUE syntax highlighting extension:"
echo "   - Ctrl/Cmd+Shift+P → 'Extensions: Install Extensions'"
echo "   - Search for 'CUE' and install the official 'CUE' extension by CUE Language"
echo ""
echo "3. Open a .cue file in a workspace containing zetta_utils to start using the extension!"
echo ""
echo "ℹ️  Extensions work together:"
echo "   - Official CUE extension: Provides syntax highlighting"
echo "   - Zetta Utils extension: Provides hover docs, validation, and completion"
echo "   - Automatically detects Python interpreter from Python extension"
echo "   - Generates metadata on first use"