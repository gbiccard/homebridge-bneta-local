import tseslint from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';
export default [{ files: ['src/**/*.ts', 'test/**/*.ts'], languageOptions: { parser, parserOptions: { ecmaVersion: 2022, sourceType: 'module' } }, plugins: { '@typescript-eslint': tseslint }, rules: { ...tseslint.configs.recommended.rules, 'no-console': 'error' } }];
