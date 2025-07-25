/**
 * Type system utilities for CUE type conversion and generation
 */

import { TypeInfo, ParameterInfo, ExtensionBuilderInfo } from './types';

/**
 * Counts the number of tab stops in a snippet template
 */
export function countTabStops(text: string): number {
    const matches = text.match(/\$\{\d+/g);
    if (!matches) return 0;

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
            const end = typeStr.indexOf(']', start);
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
    // Handle Python basic types (remove generic type checks)
    if (pythonType.includes('str')) {
        return 'string';
    }
    if (pythonType.includes('int')) {
        return 'int';
    }
    if (pythonType.includes('float')) {
        return 'float';
    }
    if (pythonType.includes('bool')) {
        return 'bool';
    }

    // Handle container types
    if (pythonType.includes('List[') || pythonType.includes('Sequence[')) {
        // Extract inner type from List[T] or Sequence[T]
        const listStart = pythonType.indexOf('[');
        const listEnd = pythonType.lastIndexOf(']');
        if (listStart !== -1 && listEnd !== -1 && listEnd > listStart) {
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
        const unionEnd = pythonType.lastIndexOf(']');
        if (unionStart !== -1 && unionEnd !== -1 && unionEnd > unionStart) {
            const unionContent = pythonType.substring(unionStart, unionEnd);
            const unionTypes = unionContent.split(',').map(t => t.trim());
            const cueTypes = unionTypes.map(t => {
                if (t === 'None' || t === 'NoneType') {
                    return 'null';
                }
                return pythonTypeToCueType(t);
            });
            return cueTypes.join(' | ');
        }
    }

    // Handle Optional types (Union with None)
    if (pythonType.includes('Optional[')) {
        const optionalStart = pythonType.indexOf('Optional[') + 9; // Skip 'Optional['
        const optionalEnd = pythonType.lastIndexOf(']');
        if (optionalStart !== -1 && optionalEnd !== -1 && optionalEnd > optionalStart) {
            const innerType = pythonType.substring(optionalStart, optionalEnd);
            const innerCueType = pythonTypeToCueType(innerType);
            return `${innerCueType} | null`;
        }
    }

    // Handle direct union with None (e.g., "SomeType | None")
    if (pythonType.includes(' | None')) {
        const baseType = pythonType.replace(' | None', '').trim();
        const baseCueType = pythonTypeToCueType(baseType);
        return `${baseCueType} | null`;
    }

    // For unknown types, return as-is
    return pythonType;
}

/**
 * Generates CUE placeholder text for a parameter
 */
export function generateCuePlaceholder(param: ParameterInfo, tabIndex: number, isOptional: boolean = false): string {
    const typeInfo = getTypeInfoFromMetadata(param);

    // For optional parameters, prioritize showing null for None defaults
    if (isOptional) {
        // Check if default is None/null (represented as null in JSON)
        if (param.default === null) {
            return 'null';
        }

        // Check if this is an optional type (union with None)
        if (typeInfo.is_optional || typeInfo.type_string.includes(' | None') || typeInfo.type_string.includes('Optional[')) {
            return 'null';
        }

        // Show actual default value if it's not None
        if (param.default !== undefined) {
            if (typeof param.default === 'string') {
                return `"${param.default}"`;
            } else if (typeof param.default === 'boolean' || typeof param.default === 'number') {
                return param.default.toString();
            } else if (Array.isArray(param.default)) {
                return JSON.stringify(param.default);
            } else {
                return JSON.stringify(param.default);
            }
        }
    }

    const typeStr = typeInfo.type_string;

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
        // Complex types - try to convert Python type to CUE type
        const cueType = pythonTypeToCueType(typeStr);
        if (cueType !== typeStr) {
            return cueType;
        }

        // Fallback for unknown complex types
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