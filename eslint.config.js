const js = require('@eslint/js');
const typescriptEslint = require('@typescript-eslint/eslint-plugin');
const typescriptParser = require('@typescript-eslint/parser');

module.exports = [
  {
    ignores: ['out/**', 'dist/**', '**/*.d.ts']
  },
  js.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module'
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        Buffer: 'readonly',
        global: 'readonly',
        Thenable: 'readonly'
      }
    },
    plugins: {
      '@typescript-eslint': typescriptEslint
    },
    rules: {
      // TypeScript ESLint recommended rules
      '@typescript-eslint/no-unused-vars': ['warn', { 'argsIgnorePattern': '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-var-requires': 'off', // Allow dynamic requires in language server
      '@typescript-eslint/naming-convention': [
        'warn',
        {
          'selector': 'import',
          'format': ['camelCase', 'PascalCase']
        }
      ],
      
      // ESLint rules
      'curly': 'warn',
      'eqeqeq': 'warn',
      'no-throw-literal': 'warn',
      'no-useless-escape': 'warn',
      'no-regex-spaces': 'warn',
      'no-unused-vars': ['warn', { 'argsIgnorePattern': '^_' }],
      'semi': 'off'
    }
  }
];