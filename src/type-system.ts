/**
 * Type system utilities for CUE type conversion and generation
 */

import { TypeInfo, ParameterInfo, ExtensionBuilderInfo } from './types';

/**
 * Counts the number of tab stops in a snippet template
 */
export function countTabStops(text: string): number {
    const matches = text.match(/\$\{\d+/g);
    if (!matches) {
        return 0;
    }

    // Extract all the tab indices and find the maximum
    const indices = matches.map(match => {
        const indexMatch = match.match(/\$\{(\d+)/);
        return indexMatch ? parseInt(indexMatch[1]) : 0;
    });

    return Math.max(...indices, 0);
}

/**
 * Extracts type information from parameter metadata
 */
export function getTypeInfoFromMetadata(param: ParameterInfo): TypeInfo {
    const typeStr = param.type || 'any';

    return {
        type_string: typeStr,
        is_sequence: typeStr.includes('Sequence') || typeStr.includes('List') || typeStr.includes('Iterable'),
        is_optional: typeStr.includes('Optional') || typeStr.includes(' | None') || !param.required,
        inner_type: extractInnerType(typeStr),
        literals: [] // Could be enhanced to extract literal values from metadata
    };
}

/**
 * Extracts inner type from container types like List[T], Optional[T], etc.
 */
function extractInnerType(typeStr: string): string | undefined {
    // Handle List[T], Sequence[T], Optional[T] patterns
    const containerPatterns = ['List[', 'Sequence[', 'Optional[', 'Union['];

    for (const pattern of containerPatterns) {
        if (typeStr.includes(pattern)) {
            const start = typeStr.indexOf(pattern) + pattern.length;
            // Use findMatchingBracket to properly handle nested brackets
            const patternStart = typeStr.indexOf(pattern) + pattern.length - 1; // Position of opening bracket
            const end = findMatchingBracket(typeStr, patternStart);
            if (start !== -1 && end !== -1 && end > start) {
                return typeStr.substring(start, end);
            }
        }
    }

    return undefined;
}

/**
 * Checks if a type string represents a basic type
 */
export function isBasicType(typeStr: string, basicType: string): boolean {
    // Simple check for basic type names
    const normalizedType = typeStr.toLowerCase();
    const normalizedBasic = basicType.toLowerCase();

    return normalizedType.includes(normalizedBasic) &&
        !normalizedType.includes('[') && // Not a container type
        !normalizedType.includes('|');   // Not a union type
}

/**
 * Converts Python type annotations to CUE type syntax
 */
export function pythonTypeToCueType(pythonType: string): string {

    // Handle basic Python types
    if (pythonType === 'str' || pythonType === 'string') {
        return 'string';
    }
    if (pythonType === 'int') {
        return 'int';
    }
    if (pythonType === 'float' || pythonType === 'number') {
        return 'float';
    }
    if (pythonType === 'bool') {
        return 'bool';
    }

    // Handle Literal types
    if (pythonType.includes('Literal[')) {
        const literalStart = pythonType.indexOf('Literal[') + 8; // Skip 'Literal['
        const literalEnd = findMatchingBracket(pythonType, literalStart - 1);
        if (literalEnd !== -1) {
            const literalContent = pythonType.substring(literalStart, literalEnd);
            // Split on commas but be careful about quoted strings
            const literals = splitLiterals(literalContent);
            if (literals.length === 1) {
                return literals[0].includes("'") || literals[0].includes('"') ? literals[0] : `"${literals[0]}"`;
            } else {
                return literals.map(lit => lit.includes("'") || lit.includes('"') ? lit : `"${lit}"`).join(' | ');
            }
        }
    }

    // Handle nested Sequence types (e.g., Sequence[Sequence[int]] or typing.Sequence[typing.Sequence[int]])
    if (pythonType.includes('Sequence[Sequence[') || pythonType.includes('Sequence[typing.Sequence[') ||
        pythonType.includes('typing.Sequence[Sequence[') || pythonType.includes('typing.Sequence[typing.Sequence[') ||
        pythonType.includes('List[List[') || pythonType.includes('typing.List[typing.List[')) {
        const outerStart = pythonType.indexOf('[');
        const outerEnd = findMatchingBracket(pythonType, outerStart);
        if (outerEnd !== -1) {
            const innerContent = pythonType.substring(outerStart + 1, outerEnd);
            if (innerContent.includes('Sequence[') || innerContent.includes('List[')) {
                const innerStart = innerContent.indexOf('[');
                const innerEnd = findMatchingBracket(innerContent, innerStart);
                if (innerEnd !== -1) {
                    const innerType = innerContent.substring(innerStart + 1, innerEnd);
                    const innerCueType = pythonTypeToCueType(innerType);
                    return `[...[...${innerCueType}]]`;
                }
            }
        }
    }

    // Handle single-level container types
    if (pythonType.includes('List[') || pythonType.includes('Sequence[') || pythonType.includes('typing.List[') || pythonType.includes('typing.Sequence[')) {
        const listStart = pythonType.indexOf('[');
        const listEnd = findMatchingBracket(pythonType, listStart);
        if (listStart !== -1 && listEnd !== -1) {
            const innerType = pythonType.substring(listStart + 1, listEnd);
            const innerCueType = pythonTypeToCueType(innerType);
            return `[...${innerCueType}]`;
        }
        return '[...]';
    }

    if (pythonType.includes('Dict[') || pythonType.includes('Mapping[')) {
        return '{...}';
    }

    // Handle Union types
    if (pythonType.includes('Union[')) {
        const unionStart = pythonType.indexOf('Union[') + 6; // Skip 'Union['
        const unionEnd = findMatchingBracket(pythonType, unionStart - 1);
        if (unionStart !== -1 && unionEnd !== -1) {
            const unionContent = pythonType.substring(unionStart, unionEnd);
            const unionTypes = splitUnionTypes(unionContent);
            const cueTypes = unionTypes.map(t => {
                if (t.trim() === 'None' || t.trim() === 'NoneType') {
                    return 'null';
                }
                // Check if type is complex (contains .) before recursive call
                if (t.trim().includes('.')) {
                    return '{...}';
                }
                const converted = pythonTypeToCueType(t.trim());
                return converted;
            });
            return cueTypes.join(' | ');
        }
    }

    // Handle direct union with None using | syntax (e.g., "SomeComplexType | None")
    // Also handle cases where there might be extra text like "< /dev/null" 
    if (pythonType.includes(' | None') || pythonType.includes(' |  None')) {
        // Clean up the type string by removing extraneous text and extracting base type
        let cleanType = pythonType.replace(/ \| {2}None.*$/, '').replace(/ \| None.*$/, '').trim();
        // Remove any shell redirection artifacts
        cleanType = cleanType.replace(/ < \/dev\/null/, '').trim();

        // Check if base type is complex (contains .) before recursive call
        if (cleanType.includes('.')) {
            return '{...} | null';
        }
        const baseCueType = pythonTypeToCueType(cleanType);
        return `${baseCueType} | null`;
    }

    // Handle Optional types (Union with None)
    if (pythonType.includes('Optional[')) {
        const optionalStart = pythonType.indexOf('Optional[') + 9; // Skip 'Optional['
        const optionalEnd = findMatchingBracket(pythonType, optionalStart - 1);
        if (optionalStart !== -1 && optionalEnd !== -1) {
            const innerType = pythonType.substring(optionalStart, optionalEnd);
            // Check if inner type is complex (contains .) before recursive call
            if (innerType.includes('.')) {
                return '{...} | null';
            }
            const innerCueType = pythonTypeToCueType(innerType);
            return `${innerCueType} | null`;
        }
    }

    // Simplify complex types (Python classes/modules) to {...}
    if (pythonType.includes('.')) {
        return '{...}';
    }

    // For unknown types, return as-is
    const result = pythonType;


    return result;
}

/**
 * Helper function to find matching bracket considering nesting
 */
function findMatchingBracket(str: string, start: number): number {
    let count = 1;
    for (let i = start + 1; i < str.length; i++) {
        if (str[i] === '[') {
            count++;
        } else if (str[i] === ']') {
            count--;
            if (count === 0) {
                return i;
            }
        }
    }
    return -1;
}

/**
 * Helper function to split union types considering nested brackets
 */
function splitUnionTypes(content: string): string[] {
    const types: string[] = [];
    let current = '';
    let depth = 0;

    for (let i = 0; i < content.length; i++) {
        const char = content[i];
        if (char === '[') {
            depth++;
        } else if (char === ']') {
            depth--;
        } else if (char === ',' && depth === 0) {
            types.push(current.trim());
            current = '';
            continue;
        }
        current += char;
    }

    if (current.trim()) {
        types.push(current.trim());
    }

    return types;
}

/**
 * Helper function to split literal values considering quotes
 */
function splitLiterals(content: string): string[] {
    const literals: string[] = [];
    let current = '';
    let inQuotes = false;
    let quoteChar = '';

    for (let i = 0; i < content.length; i++) {
        const char = content[i];
        if ((char === '"' || char === "'") && !inQuotes) {
            inQuotes = true;
            quoteChar = char;
            current += char;
        } else if (char === quoteChar && inQuotes) {
            inQuotes = false;
            current += char;
        } else if (char === ',' && !inQuotes) {
            literals.push(current.trim());
            current = '';
        } else if (char !== ' ' || inQuotes) {
            current += char;
        }
    }

    if (current.trim()) {
        literals.push(current.trim());
    }

    return literals;
}

/**
 * Generates CUE placeholder text for a parameter
 */
export function generateCuePlaceholder(param: ParameterInfo, tabIndex: number, isOptional: boolean = false): string {
    const typeInfo = getTypeInfoFromMetadata(param);


    // First, check if there's an actual default value (for both required and optional parameters)
    if (param.default !== undefined && param.default !== null) {
        if (typeof param.default === 'string') {
            return `"${param.default}"`;
        } else if (typeof param.default === 'boolean' || typeof param.default === 'number') {
            return param.default.toString();
        } else if (Array.isArray(param.default)) {
            // Format arrays nicely: [0,0,0] -> [0, 0, 0]
            return `[${param.default.join(', ')}]`;
        } else {
            return JSON.stringify(param.default);
        }
    }

    const typeStr = typeInfo.type_string;

    // For optional parameters, check if they should default to null
    if (isOptional) {
        // Check if default is explicitly None/null
        if (param.default === null) {
            return 'null';
        }

        // Check if this is an optional type (union with None) and has no default
        if (param.default === undefined && (typeInfo.is_optional || typeInfo.type_string.includes(' | None') || typeInfo.type_string.includes(' |  None') || typeInfo.type_string.includes('Optional['))) {
            return 'null';
        }
    }

    // Always check for union types with None first (both required and optional params can have None as valid value)
    if (typeStr.includes(' | None') || typeStr.includes(' |  None') || typeStr.includes('Union[') || typeStr.includes('Optional[')) {
        const cueType = pythonTypeToCueType(typeStr);
        if (cueType !== typeStr) {
            return cueType;
        }
    }

    // Handle literal types - show all available options as CUE union
    if (typeInfo.literals.length > 0) {
        const uniqueLiterals = Array.from(new Set(typeInfo.literals));
        if (uniqueLiterals.length === 1) {
            // Single literal value
            return typeof uniqueLiterals[0] === 'string' ? `"${uniqueLiterals[0]}"` : String(uniqueLiterals[0]);
        } else {
            // Multiple literal options - show as CUE union type
            const literalValues = uniqueLiterals.map(lit =>
                typeof lit === 'string' ? `"${lit}"` : String(lit)
            ).join(' | ');
            return literalValues;
        }
    }

    // Generate CUE type annotations instead of arbitrary values
    if (typeStr.includes('Vec3D[int]')) {
        return '[int, int, int]';
    } else if (typeStr.includes('Vec3D[float]') || (typeStr.includes('Vec3D') && !typeStr.includes('Vec3D['))) {
        return '[float, float, float]';
    } else if (typeInfo.is_sequence || typeStr.includes('Sequence') || typeStr.includes('List') || typeStr.includes('Iterable')) {
        // Handle nested sequences like Sequence[Sequence[int]]
        if (typeStr.includes('Sequence[Sequence[') || (typeInfo.inner_type && typeInfo.inner_type.includes('Sequence['))) {
            // Check if inner_type contains a Sequence
            if (typeInfo.inner_type && typeInfo.inner_type.includes('Sequence[')) {
                const seqStart = typeInfo.inner_type.indexOf('Sequence[') + 9; // Skip 'Sequence['
                const seqEnd = typeInfo.inner_type.indexOf(']', seqStart);
                if (seqStart !== -1 && seqEnd !== -1 && seqEnd > seqStart) {
                    const innerInnerType = typeInfo.inner_type.substring(seqStart, seqEnd);
                    const innerCueType = pythonTypeToCueType(innerInnerType);
                    return `[[...${innerCueType}]]`;
                }
            }
            // Fallback for nested sequence parsing
            const nestedSeqPattern = 'Sequence[Sequence[';
            const nestedSeqStart = typeStr.indexOf(nestedSeqPattern);
            if (nestedSeqStart !== -1) {
                const innerStart = nestedSeqStart + nestedSeqPattern.length;
                const firstClose = typeStr.indexOf(']', innerStart);
                const secondClose = typeStr.indexOf(']', firstClose + 1);
                if (firstClose !== -1 && secondClose !== -1) {
                    const innerType = typeStr.substring(innerStart, firstClose);
                    const innerCueType = pythonTypeToCueType(innerType);
                    return `[[...${innerCueType}]]`;
                }
            }
        }

        // Determine inner type for regular sequences
        if (typeInfo.inner_type) {
            const innerCueType = pythonTypeToCueType(typeInfo.inner_type);
            return `[...${innerCueType}]`;
        }
        return '[...]';
    } else if (isBasicType(typeStr, 'str') || isBasicType(typeStr, 'string')) {
        return 'string';
    } else if (isBasicType(typeStr, 'int')) {
        return 'int';
    } else if (isBasicType(typeStr, 'float') || isBasicType(typeStr, 'number')) {
        return 'float';
    } else if (isBasicType(typeStr, 'bool')) {
        return 'bool';
    } else {
        // Complex types - always try to convert Python type to CUE type first
        const cueType = pythonTypeToCueType(typeStr);

        // If the conversion worked and doesn't contain Python module paths, use it
        if (cueType !== typeStr && !cueType.includes('.')) {
            return cueType;
        }

        // Fallback for unknown complex types and long module paths
        if (typeStr.includes('Sequence') || typeStr.includes('List') || typeStr.includes('Iterable')) {
            return '[...]';
        } else {
            return '{...}';
        }
    }
}

/**
 * Gets a formatted list of required parameters for a builder
 */
export function getRequiredParametersList(builder: ExtensionBuilderInfo): string {
    const requiredParams = builder.parameters.filter(p => p.required);
    return requiredParams.map(p => `"${p.name}"`).join(', ');
}