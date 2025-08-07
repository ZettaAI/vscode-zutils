/**
 * Metadata management for builder information
 */

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as semver from 'semver';
import {
    ExtensionBuilderInfo,
    BuilderMetadata,
    BuilderLookup,
    ZettaUtilsCueSettings
} from './types';

const execAsync = promisify(exec);

// Global state for metadata
export let extensionBuilders: ExtensionBuilderInfo[] = [];
export let builderLookup: BuilderLookup = {};
export let defaultVersion: string = '0.0.0';
export let zettaUtilsPackagePath: string = '';
export let isMetadataLoaded: boolean = false;

/**
 * Resolves relative paths within zetta_utils package to absolute paths
 */
export function resolveZettaUtilsPath(relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath)) {
        return relativePath;
    }

    // Handle paths with <zetta_utils>/ prefix from Python script
    if (relativePath.startsWith('<zetta_utils>/')) {
        const pathWithoutPrefix = relativePath.substring('<zetta_utils>/'.length);
        if (zettaUtilsPackagePath) {
            // The prefix indicates path relative to zetta_utils parent directory
            return path.join(path.dirname(zettaUtilsPackagePath), pathWithoutPrefix);
        }
        return pathWithoutPrefix;
    }


    // Regular relative paths
    if (zettaUtilsPackagePath) {
        return path.join(zettaUtilsPackagePath, relativePath);
    }

    return relativePath;
}

/**
 * Extracts builder metadata using the Python script
 */
export async function extractBuilderMetadata(outputPath?: string, pythonPath?: string): Promise<string | null> {
    try {
        if (!pythonPath) {
            throw new Error('Python path is required. Please ensure Python extension is installed and configured.');
        }
        const finalPythonPath = pythonPath;

        // Output path is required when no cache dir fallback
        if (!outputPath) {
            throw new Error('Output path is required for metadata extraction');
        }
        const finalOutputPath = outputPath;

        // Ensure output directory exists
        const targetDir = path.dirname(finalOutputPath);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        // Find the script path relative to the extension
        const scriptPath = path.join(__dirname, '..', 'scripts', 'extract_builder_metadata.py');

        if (!fs.existsSync(scriptPath)) {
            throw new Error(`Script not found: ${scriptPath}`);
        }

        // Set up environment to find zetta_utils package
        // Assume we're running from the zetta_utils development directory
        const zettatUtilsRoot = path.resolve(__dirname, '..', '..', '..');
        const pythonPath_env = process.env.PYTHONPATH ? `${zettatUtilsRoot}:${process.env.PYTHONPATH}` : zettatUtilsRoot;

        // The Python script expects --output-dir and creates builder_metadata.json inside it
        const outputDir = path.dirname(finalOutputPath);
        const command = `"${finalPythonPath}" "${scriptPath}" --output-dir "${outputDir}"`;
        console.log(`Executing: ${command}`);
        console.log(`PYTHONPATH: ${pythonPath_env}`);
        console.log(`Expected output file: ${finalOutputPath}`);

        const { stdout, stderr } = await execAsync(command, {
            timeout: 60000, // 60 second timeout
            maxBuffer: 1024 * 1024 * 10, // 10MB buffer
            env: {
                ...process.env,
                PYTHONPATH: pythonPath_env
            },
            cwd: zettatUtilsRoot
        });

        if (stderr) {
            console.warn('Python script stderr:', stderr);
        }

        console.log('Python script output:', stdout);

        // The Python script outputs the actual path of the created file as the last line
        const lines = stdout.trim().split('\n');
        const actualOutputPath = lines[lines.length - 1].trim();

        if (fs.existsSync(actualOutputPath)) {
            return actualOutputPath;
        } else if (fs.existsSync(finalOutputPath)) {
            return finalOutputPath;
        } else {
            throw new Error(`Metadata file was not created at expected paths: ${actualOutputPath} or ${finalOutputPath}`);
        }
    } catch (error) {
        console.error('Failed to extract builder metadata:', error);
        return null;
    }
}

/**
 * Resolves a builder by name and version, returning the best matching builder
 */
export function resolveBuilder(builderName: string, requestedVersion?: string): ExtensionBuilderInfo | null {
    const version = requestedVersion || defaultVersion;

    const candidateBuilders = extensionBuilders.filter(b =>
        stripVersionSuffix(b.name) === stripVersionSuffix(builderName) || b.name === builderName
    );

    if (candidateBuilders.length === 0) {
        return null;
    }

    return findBestVersionMatch(version, candidateBuilders);
}

/**
 * Finds the best version match for a builder using semver
 */
export function findBestVersionMatch(requestedVersion: string, candidates: ExtensionBuilderInfo[]): ExtensionBuilderInfo | null {
    if (candidates.length === 0) {
        return null;
    }

    // Find all candidates that satisfy the requested version
    const matchingCandidates = candidates.filter(candidate => {
        const versionSpec = candidate.version_spec;
        if (!versionSpec) {
            return false;
        }

        try {
            // Normalize version to full semver format (e.g., "0.4" -> "0.4.0")
            const normalizedVersion = semver.coerce(requestedVersion);
            if (!normalizedVersion) {
                console.warn(`Invalid version '${requestedVersion}' for builder '${candidate.name}'`);
                return false;
            }

            // Use semver to check if the requested version satisfies the spec
            return semver.satisfies(normalizedVersion.version, versionSpec);
        } catch (error) {
            console.warn(`Invalid version spec '${versionSpec}' for builder '${candidate.name}': ${error}`);
            return false;
        }
    });

    if (matchingCandidates.length === 0) {
        console.warn(`No builders found that satisfy version ${requestedVersion} among candidates: ${candidates.map(c => `${c.name}:${c.version_spec}`).join(', ')}`);
        return null;
    }

    if (matchingCandidates.length > 1) {
        const builderNames = matchingCandidates.map(c => `${c.name}:${c.version_spec}`).join(', ');
        throw new Error(`Multiple builders found that satisfy version ${requestedVersion}: ${builderNames}. This indicates an error in the Zetta Utils repository - there should be exactly one matching builder.`);
    }

    return matchingCandidates[0] || null;
}

/**
 * Strips version suffix from builder names for cleaner display
 */
export function stripVersionSuffix(builderName: string): string {
    // Handle both dots and underscores in version suffixes: _v0_3 or _v0.3
    return builderName.replace(/_v\d+(?:[_.]\d+)*$/, '');
}

/**
 * Loads builder metadata from file
 */
export async function loadBuilderMetadata(settings: ZettaUtilsCueSettings): Promise<void> {
    try {
        let metadataPath = settings.metadataPath;

        // If no metadata path configured or file doesn't exist, try to generate fresh metadata
        // Also check for builder_metadata.json in the same directory in case it was generated previously
        let needsGeneration = false;
        if (!metadataPath) {
            needsGeneration = true;
        } else if (!fs.existsSync(metadataPath)) {
            // Check if builder_metadata.json exists in the same directory
            const alternativeFile = path.join(path.dirname(metadataPath), 'builder_metadata.json');
            if (fs.existsSync(alternativeFile)) {
                console.log(`Using existing metadata file: ${alternativeFile}`);
                metadataPath = alternativeFile;
            } else {
                needsGeneration = true;
            }
        }

        if (needsGeneration) {
            console.log('No valid metadata path configured or file missing, attempting to generate fresh metadata...');

            if (settings.pythonPath) {
                const extractedPath = await extractBuilderMetadata(metadataPath, settings.pythonPath);

                if (extractedPath && fs.existsSync(extractedPath)) {
                    metadataPath = extractedPath;
                    console.log(`Generated fresh metadata: ${metadataPath}`);
                } else {
                    console.warn('Failed to generate metadata file. Extension will run with limited functionality.');
                    console.warn('To enable full functionality, either:');
                    console.warn('1. Install zetta_utils in your Python environment, or');
                    console.warn('2. Provide a custom metadataPath in settings pointing to a pre-generated metadata file');

                    // Initialize empty metadata so the extension still works
                    extensionBuilders = [];
                    builderLookup = {};
                    defaultVersion = '0.0.0';
                    isMetadataLoaded = false;
                    return;
                }
            } else {
                console.warn('No Python path configured. Extension will run with limited functionality.');
                extensionBuilders = [];
                builderLookup = {};
                defaultVersion = '0.0.0';
                isMetadataLoaded = false;
                return;
            }
        }

        if (fs.existsSync(metadataPath)) {
            console.log(`Attempting to read metadata file: ${metadataPath}`);
            console.log(`File stats:`, fs.statSync(metadataPath));
            const content = fs.readFileSync(metadataPath, 'utf8');
            const rawMetadata = JSON.parse(content);

            // Parse metadata with default_version
            if (rawMetadata && typeof rawMetadata === 'object' && rawMetadata.builders) {
                const metadata: BuilderMetadata = rawMetadata;
                extensionBuilders = metadata.builders;
                defaultVersion = metadata.default_version;
                console.log(`Loaded ${extensionBuilders.length} builders with default version: ${defaultVersion}`);
            } else {
                throw new Error('Invalid metadata format - expected object with builders array and default_version');
            }

            // Load package path info for proper file URI resolution
            try {
                const packageInfoPath = metadataPath.replace('builder_metadata.json', 'package_info.json');
                if (fs.existsSync(packageInfoPath)) {
                    const packageInfo = JSON.parse(fs.readFileSync(packageInfoPath, 'utf-8'));
                    zettaUtilsPackagePath = packageInfo.zetta_utils_package_path;
                    console.log(`Loaded zetta_utils package path: ${zettaUtilsPackagePath}`);
                }
            } catch (error) {
                console.log(`Warning: Could not load package path info: ${error}`);
            }

            // Create lookup index for fast access
            builderLookup = {};
            extensionBuilders.forEach(builder => {
                builderLookup[builder.name] = builder;
            });

            console.log(`Loaded ${extensionBuilders.length} builders`);

            // Update file paths to be absolute for source links
            extensionBuilders.forEach(builder => {
                if (builder.metadata?.file) {
                    builder.metadata.file = resolveZettaUtilsPath(builder.metadata.file);
                }
            });

            // Mark metadata as successfully loaded
            isMetadataLoaded = true;
        } else {
            console.error(`Metadata file not found: ${metadataPath}`);
        }
    } catch (error) {
        console.error(`Error loading builder metadata: ${error}`);
        extensionBuilders = [];
        builderLookup = {};
        isMetadataLoaded = false;
    }
}

/**
 * Refreshes builder metadata by regenerating it
 */
export async function refreshBuilderMetadata(targetPath?: string, pythonPath?: string): Promise<void> {
    try {
        if (!pythonPath) {
            throw new Error('Python path is required. Please ensure Python extension is installed and configured.');
        }
        const finalPythonPath = pythonPath;
        const extractedPath = await extractBuilderMetadata(targetPath, finalPythonPath);

        if (extractedPath && fs.existsSync(extractedPath)) {
            // Reload with the fresh metadata
            const settings: ZettaUtilsCueSettings = {
                enableAutocomplete: true,
                enableValidation: true,
                metadataPath: extractedPath,
                pythonPath: finalPythonPath
            };

            await loadBuilderMetadata(settings);
            console.log('Builder metadata refreshed successfully');
        } else {
            throw new Error('Failed to generate fresh metadata');
        }
    } catch (error) {
        console.error('Failed to refresh builder metadata:', error);
    }
}