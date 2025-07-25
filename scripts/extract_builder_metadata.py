#!/usr/bin/env python3
"""
Extract metadata from zetta_utils builder registry for VS Code extension autocomplete.

This script analyzes all registered builders and their function signatures to generate
a comprehensive JSON schema that can be used by a VS Code extension for intelligent
autocomplete and validation of CUE specifications.
"""

import argparse
import collections.abc
import inspect
import json
import sys
import tempfile
import traceback
import typing
from pathlib import Path
from typing import Any, Dict, get_type_hints

try:
    from typing import get_args, get_origin
except ImportError:
    # Fallback for older Python versions
    from typing_extensions import get_args, get_origin


def find_zetta_utils_package():
    """Find the zetta_utils package installation directory."""
    try:
        import zetta_utils as zu  # pylint: disable=import-outside-toplevel

        zetta_package_path = Path(zu.__file__).parent
        print(f"Found zetta_utils package at: {zetta_package_path}")
        return zetta_package_path
    except ImportError:
        print(
            "Error: zetta_utils package not found. "
            "Please ensure it's installed in the current Python environment."
        )
        sys.exit(1)


def make_path_relative_to_package(absolute_path: str, zetta_package_path: Path) -> str:
    """Convert absolute path to relative path from zetta_utils package root."""
    try:
        abs_path = Path(absolute_path)
        if zetta_package_path in abs_path.parents or abs_path == zetta_package_path:
            relative_path = abs_path.relative_to(zetta_package_path.parent)
            return f"<zetta_utils>/{relative_path}"
        else:
            # Path is outside zetta_utils package, keep as is but mark it
            return f"<external>/{abs_path}"
    except (ValueError, TypeError):
        return absolute_path


# Find and add zetta_utils to path dynamically
zetta_utils_package_path = find_zetta_utils_package()
if str(zetta_utils_package_path.parent) not in sys.path:
    sys.path.insert(0, str(zetta_utils_package_path.parent))

try:
    # Import zetta_utils to populate the registry
    import zetta_utils
    from zetta_utils.builder.constants import DEFAULT_VERSION
    from zetta_utils.builder.registry import REGISTRY

    # Load all modules to ensure all builders are registered
    print("Loading all zetta_utils modules...")
    zetta_utils.load_all_modules()
    print("Successfully loaded all modules")

except ImportError as import_error:
    print(f"Error importing zetta_utils: {import_error}")
    print("Make sure you're running this script from the zetta_utils directory")
    sys.exit(1)


def _extract_literals_from_annotation(origin, args):
    """Helper function to extract literal values from type annotations."""
    literals = []

    if origin is typing.Literal:
        literals = list(args)
        return literals

    if origin is not typing.Union or not args:
        return literals

    # Check for Literal types in Union args - handle nested structures
    for arg in args:
        if get_origin(arg) is typing.Literal:
            literals.extend(get_args(arg))
            continue

        # Also check for Sequence[Literal[...]]
        if not (hasattr(arg, "__origin__") and hasattr(arg, "__args__")):
            continue

        inner_origin = get_origin(arg)
        inner_args = get_args(arg)
        if not (inner_origin and inner_args):
            continue

        for inner_arg in inner_args:
            if get_origin(inner_arg) is typing.Literal:
                literals.extend(get_args(inner_arg))

    return literals


def _check_sequence_type(origin, args):
    """Helper function to check if type is a sequence and extract inner type."""
    is_sequence = False
    inner_type = None

    if origin is None:
        return is_sequence, inner_type

    # Check for sequence-like types
    if hasattr(origin, "__name__"):
        origin_name = origin.__name__.lower()
        sequence_names = ["sequence", "list", "tuple", "iterable"]
        if any(seq_name in origin_name for seq_name in sequence_names):
            is_sequence = True
            if args:
                inner_type = str(args[0])

    # Also handle typing.Sequence directly
    try:
        if origin is collections.abc.Sequence or str(origin) == "typing.Sequence":
            is_sequence = True
            if args:
                inner_type = str(args[0])
    except (AttributeError, TypeError):
        pass

    return is_sequence, inner_type


def extract_type_info(annotation) -> Dict[str, Any]:
    """Extract detailed type information using proper typing inspection."""

    if annotation == inspect.Parameter.empty:
        return {
            "type_string": "Any",
            "origin": None,
            "args": [],
            "literals": [],
            "is_union": False,
            "is_optional": False,
            "is_sequence": False,
            "inner_type": None,
        }

    # Get origin and args using proper typing inspection
    origin = get_origin(annotation)
    args = get_args(annotation)

    # Extract literal values using helper function
    literals = _extract_literals_from_annotation(origin, args)

    # Check if it's a Union and if it's optional (Union with None)
    is_union = origin is typing.Union
    is_optional = is_union and type(None) in args

    # Check if it's a sequence type using helper function
    is_sequence, inner_type = _check_sequence_type(origin, args)

    # Generate clean type string but preserve original for compatibility
    type_string = str(annotation)

    return {
        "type_string": type_string,
        "origin": str(origin) if origin else None,
        "args": [str(arg) for arg in args],
        "literals": literals,
        "is_union": is_union,
        "is_optional": is_optional,
        "is_sequence": is_sequence,
        "inner_type": inner_type,
    }


def get_type_annotation_string(annotation) -> str:
    """Convert type annotation to string representation (legacy compatibility)."""
    return extract_type_info(annotation)["type_string"]


def unwrap_decorated_function(fn: callable) -> callable:
    """Unwrap a decorated function to get the original function.

    This handles common zetta_utils decorators like @supports_dict, @typechecked, etc.
    """
    original_fn = fn
    max_unwrap_depth = 10  # Prevent infinite loops
    depth = 0

    while depth < max_unwrap_depth:
        depth += 1
        unwrapped_something = False

        # Try to unwrap using __wrapped__ attribute (functools.wraps)
        if hasattr(original_fn, "__wrapped__"):
            original_fn = original_fn.__wrapped__
            unwrapped_something = True
            continue

        # Handle specific zetta_utils wrapper patterns
        # Check if this is a DictSupportingTensorOp instance (from @supports_dict decorator)
        if hasattr(original_fn, "fn") and callable(getattr(original_fn, "fn", None)):
            # This is likely a DictSupportingTensorOp or similar wrapper class
            class_name = type(original_fn).__name__
            if "DictSupportingTensorOp" in class_name or hasattr(
                original_fn, "__call__"
            ):
                original_fn = original_fn.fn
                unwrapped_something = True
                continue

        # Handle other common wrapper patterns
        if hasattr(original_fn, "_wrapped_fn") and callable(
            getattr(original_fn, "_wrapped_fn", None)
        ):
            original_fn = original_fn._wrapped_fn  # pylint: disable=protected-access
            unwrapped_something = True
            continue

        # Handle functools.partial objects
        if hasattr(original_fn, "func") and callable(
            getattr(original_fn, "func", None)
        ):
            original_fn = original_fn.func
            unwrapped_something = True
            continue

        # Handle closures from decorators that don't use functools.wraps
        # This is a more aggressive approach for cases like @skip_on_empty_data
        if hasattr(original_fn, "__closure__") and original_fn.__closure__:
            # Check if closure contains a callable that might be the original function
            for cell in original_fn.__closure__:
                if cell.cell_contents and callable(cell.cell_contents):
                    # Check if this callable has a different name than the wrapper
                    # and seems like it could be the original function
                    cell_fn = cell.cell_contents
                    if (
                        hasattr(cell_fn, "__name__")
                        and cell_fn.__name__ != original_fn.__name__
                        and cell_fn.__name__ != "wrapped"
                        and not cell_fn.__name__.startswith("_")
                    ):
                        original_fn = cell_fn
                        unwrapped_something = True
                        break
            if unwrapped_something:
                continue

        # If nothing was unwrapped, we're done
        if not unwrapped_something:
            break

    return original_fn


def extract_function_signature(fn: callable) -> Dict[str, Any]:
    """Extract detailed function signature information."""
    try:
        # Try to unwrap decorated functions first
        original_fn = unwrap_decorated_function(fn)

        # Use the unwrapped function for signature inspection
        sig = inspect.signature(original_fn)
        parameters = {}

        # Get actual type hints to properly inspect type objects
        try:
            type_hints = get_type_hints(original_fn)
        except (TypeError, AttributeError, NameError) as error:
            fn_name = getattr(original_fn, "__name__", str(original_fn))
            print(f"Warning: Could not get type hints for {fn_name}: {error}")
            type_hints = {}

        for param_name, param in sig.parameters.items():
            # Use actual type hint if available, otherwise fall back to string annotation
            actual_annotation = type_hints.get(param_name, param.annotation)

            # Extract detailed type information from the actual type object
            type_info = extract_type_info(actual_annotation)

            param_info = {
                "name": param_name,
                "type": type_info["type_string"],
                "type_info": type_info,  # Rich type information
                "required": param.default == inspect.Parameter.empty,
                "default": (
                    None if param.default == inspect.Parameter.empty else param.default
                ),
                "kind": param.kind.name,  # POSITIONAL_ONLY, POSITIONAL_OR_KEYWORD, etc.
            }

            # Handle complex default values that can't be serialized
            if param_info["default"] is not None:
                try:
                    json.dumps(param_info["default"])
                except (TypeError, ValueError):
                    param_info["default"] = str(param_info["default"])
                    param_info["default_repr"] = repr(param_info["default"])

            # Ensure type_info is JSON serializable
            try:
                json.dumps(param_info["type_info"])
            except (TypeError, ValueError) as json_error:
                print(
                    f"Warning: type_info for {param_name} not JSON serializable: {json_error}"
                )
                # Convert any non-serializable values to strings
                param_info["type_info"] = {
                    k: str(v) if v is not None else None for k, v in type_info.items()
                }

            parameters[param_name] = param_info

        return {
            "parameters": parameters,
            "return_type": get_type_annotation_string(sig.return_annotation),
        }

    except (TypeError, ValueError, AttributeError) as extraction_error:
        return {
            "parameters": {},
            "return_type": "Any",
            "error": f"Failed to extract signature: {str(extraction_error)}",
        }


def extract_docstring_info(fn: callable) -> Dict[str, Any]:
    """Extract and parse docstring information."""
    # Unwrap decorated function to get original docstring
    original_fn = unwrap_decorated_function(fn)
    doc = inspect.getdoc(original_fn)
    if not doc:
        return {"summary": "", "description": "", "parameters": {}}

    lines = doc.split("\n")
    summary = lines[0] if lines else ""

    # Simple docstring parsing - could be enhanced with proper parsing libraries
    param_docs = {}
    current_param = None
    description_lines = []
    in_params_section = False

    for line in lines[1:]:
        line = line.strip()
        if line.startswith(":param "):
            in_params_section = True
            parts = line.split(":", 2)
            if len(parts) >= 3:
                param_name = parts[1].replace("param ", "").strip()
                param_desc = parts[2].strip()
                param_docs[param_name] = param_desc
                current_param = param_name
        elif line.startswith(":") and current_param:
            # End of parameter documentation
            current_param = None
            in_params_section = False
        elif current_param and line:
            # Continue parameter description
            param_docs[current_param] += " " + line
        elif not in_params_section and line and not line.startswith(":"):
            description_lines.append(line)

    return {
        "summary": summary,
        "description": " ".join(description_lines),
        "parameters": param_docs,
    }


def extract_builder_metadata() -> Dict[str, Any]:
    """Extract comprehensive metadata from all registered builders."""
    metadata = {
        "version": "1.0.0",
        "generated_at": str(Path(__file__).parent),
        "zetta_utils_version": getattr(zetta_utils, "__version__", "unknown"),
        "builders": {},
        "statistics": {
            "total_builders": 0,
            "total_entries": 0,
            "builders_with_partial": 0,
            "builders_with_parallel": 0,
        },
    }

    total_entries = 0
    builders_with_partial = 0
    builders_with_parallel = 0

    for builder_name, entries in REGISTRY.items():
        total_entries += len(entries)

        # Process each version of the builder
        builder_versions = []
        for entry in entries:
            fn = entry.fn

            # Extract function metadata
            signature_info = extract_function_signature(fn)
            docstring_info = extract_docstring_info(fn)

            # Count capabilities
            if entry.allow_partial:
                builders_with_partial += 1
            if entry.allow_parallel:
                builders_with_parallel += 1

            # Unwrap function to get correct metadata
            original_fn = unwrap_decorated_function(fn)

            # Handle different types of callables
            function_name = getattr(
                original_fn, "__name__", str(type(original_fn).__name__)
            )
            module_name = getattr(original_fn, "__module__", "unknown")

            try:
                file_path = inspect.getfile(original_fn)
                # Convert to relative path from package root
                file_path = make_path_relative_to_package(
                    file_path, zetta_utils_package_path
                )
            except (TypeError, OSError):
                file_path = "unknown"

            try:
                line_number = (
                    original_fn.__code__.co_firstlineno
                    if hasattr(original_fn, "__code__")
                    else 0
                )
            except AttributeError:
                line_number = 0

            version_info = {
                "function_name": function_name,
                "module": module_name,
                "file": file_path,
                "line_number": line_number,
                "allow_partial": entry.allow_partial,
                "allow_parallel": entry.allow_parallel,
                "version_spec": str(entry.version_spec),
                "signature": signature_info,
                "documentation": docstring_info,
                "callable_type": str(type(fn).__name__),
            }

            builder_versions.append(version_info)

        metadata["builders"][builder_name] = {
            "name": builder_name,
            "versions": builder_versions,
            "latest_version": builder_versions[0] if builder_versions else None,
        }

    # Update statistics
    metadata["statistics"].update(
        {
            "total_builders": len(metadata["builders"]),
            "total_entries": total_entries,
            "builders_with_partial": builders_with_partial,
            "builders_with_parallel": builders_with_parallel,
        }
    )

    return metadata


def convert_to_extension_format(metadata: Dict[str, Any]) -> Dict[str, Any]:
    """Convert metadata from object format to format expected by VS Code extension.

    Creates separate builder entries for each version, using versioned names for older versions.
    """
    extension_metadata = []

    def version_spec_to_suffix(version_spec: str) -> str:
        """Convert version spec to suffix for builder name."""
        if version_spec == ">=0.0.0" or version_spec.startswith(">="):
            # This is the latest version, no suffix needed
            return ""
        elif version_spec.startswith("=="):
            # Extract version number and convert to suffix
            version = version_spec[2:]  # Remove "=="
            return "_v" + version.replace(".", "_")
        elif version_spec.startswith("<="):
            # For range versions, use the upper bound
            version = version_spec[2:]  # Remove "<="
            return "_v" + version.replace(".", "_")
        else:
            # Fallback for other version specs
            cleaned_spec = (
                version_spec.replace(".", "_")
                .replace(">", "gt")
                .replace("<", "lt")
                .replace("=", "eq")
            )
            return "_v" + cleaned_spec

    for builder_name, builder_info in metadata["builders"].items():
        if not builder_info["versions"]:
            continue

        # Process each version as a separate builder
        for version_info in builder_info["versions"]:
            signature = version_info.get("signature", {})
            parameters_dict = signature.get("parameters", {})

            # Convert parameters from dict to array
            parameters_array = []
            for _, param_info in parameters_dict.items():
                parameters_array.append(
                    {
                        "name": param_info["name"],
                        "type": param_info["type"],
                        "type_info": param_info.get("type_info", {}),
                        "required": param_info["required"],
                        "default": param_info["default"],
                        "kind": param_info.get("kind", "POSITIONAL_OR_KEYWORD"),
                    }
                )

            # Determine builder name with version suffix if needed
            version_suffix = version_spec_to_suffix(version_info["version_spec"])
            versioned_builder_name = builder_name + version_suffix

            extension_metadata.append(
                {
                    "name": versioned_builder_name,
                    "parameters": parameters_array,
                    "version_spec": version_info[
                        "version_spec"
                    ],  # Store original version spec
                    "metadata": {
                        "function_name": version_info["function_name"],
                        "module": version_info["module"],
                        "file": version_info.get("file"),
                        "line_number": version_info.get("line_number"),
                        "allow_partial": version_info["allow_partial"],
                        "allow_parallel": version_info["allow_parallel"],
                        "documentation": version_info.get("documentation", {}),
                    },
                }
            )

    return {"builders": extension_metadata, "default_version": DEFAULT_VERSION}


def main():
    """Main entry point for metadata extraction."""
    parser = argparse.ArgumentParser(
        description="Extract zetta_utils builder metadata for VSCode extension"
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        help="Output directory for metadata files (defaults to temp directory)",
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true", help="Enable verbose output"
    )

    args = parser.parse_args()

    # Use provided output directory or create temp directory
    if args.output_dir:
        output_dir = Path(args.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
    else:
        output_dir = Path(tempfile.gettempdir()) / "zetta_utils_vscode_metadata"
        output_dir.mkdir(parents=True, exist_ok=True)

    if args.verbose:
        print(f"Output directory: {output_dir}")
        print("Extracting zetta_utils builder metadata...")

    try:
        # Extract metadata
        metadata = extract_builder_metadata()

        # Convert to extension format
        extension_format = convert_to_extension_format(metadata)

        # Write extension format (main file used by VSCode)
        extension_output_path = output_dir / "builder_metadata.json"
        with open(extension_output_path, "w", encoding="utf-8") as f:
            json.dump(extension_format, f, indent=2, default=str)

        # Write package path info for the VSCode extension
        package_info = {"zetta_utils_package_path": str(zetta_utils_package_path)}
        package_info_path = output_dir / "package_info.json"
        with open(package_info_path, "w", encoding="utf-8") as f:
            json.dump(package_info, f, indent=2, default=str)

        if args.verbose:
            total_builders = metadata["statistics"]["total_builders"]
            print(f"✅ Successfully extracted metadata for {total_builders} builders")
            print(f"   Total entries: {metadata['statistics']['total_entries']}")
            print(
                f"   With partial support: {metadata['statistics']['builders_with_partial']}"
            )
            print(
                f"   With parallel support: {metadata['statistics']['builders_with_parallel']}"
            )
            print("   Generated files:")
            print(f"     • {extension_output_path}")
            print(f"     • {package_info_path}")
            print(f"   Extension array length: {len(extension_format)}")

            # Show sample builders
            builder_names = list(metadata["builders"].keys())[:10]
            print("\n🔍 Sample builders found:")
            for name in builder_names:
                print(f"   {name}")
            if len(metadata["builders"]) > 10:
                print(f"   ... and {len(metadata['builders']) - 10} more")

        # Always print the main output path for programmatic use
        print(extension_output_path)

    except (ImportError, RuntimeError, FileNotFoundError) as error:
        print(f"❌ Error extracting metadata: {error}", file=sys.stderr)
        if args.verbose:
            traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
