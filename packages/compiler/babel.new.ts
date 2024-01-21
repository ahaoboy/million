import type * as t from '@babel/types';
import type { PluginObj, PluginPass } from '@babel/core';
import type { ImportDefinition, StateContext } from "./types";
import { IMPORTS } from './constants.new';
import { transformBlock } from './block.new';

function getImportSpecifierName(specifier: t.ImportSpecifier): string {
  if (specifier.imported.type === 'Identifier') {
    return specifier.imported.name;
  }
  return specifier.imported.value;
}

function registerImportDefinition(
  ctx: StateContext,
  path: babel.NodePath<t.ImportDeclaration>,
  definition: ImportDefinition,
): void {
  for (let i = 0, len = path.node.specifiers.length; i < len; i++) {
    const specifier = path.node.specifiers[i]!;
    switch (specifier.type) {
      case 'ImportDefaultSpecifier': {
        if (definition.kind === 'default') {
          ctx.definitions.identifiers.set(specifier.local, definition);
        }
        break;
      }
      case 'ImportNamespaceSpecifier': {
        let current = ctx.definitions.namespaces.get(specifier.local);
        if (!current) {
          current = [];
        }
        current.push(definition);
        ctx.definitions.namespaces.set(specifier.local, current);
        break;
      }
      case 'ImportSpecifier': {
        const key = getImportSpecifierName(specifier);
        if (
          (
            definition.kind === 'named'
            && key === definition.name
          )
          || (
            definition.kind === 'default'
            && key === 'default'
          )
        ) {
          ctx.definitions.identifiers.set(specifier.local, definition);
        }
        break;
      }
    }
  }
}

interface PluginState extends PluginPass {
  state: StateContext;
  opts: {
    mode: 'client' | 'server';
  };
}

export function babel(): PluginObj<PluginState> {
  return {
    name: 'million',
    pre(): void {
      this.state = {
        mode: this.opts.mode,
        definitions: {
          identifiers: new Map(),
          namespaces: new Map(),
        },
        imports: new Map(),
      };
    },
    visitor: {
      Program(programPath, ctx) {
        programPath.traverse({
          ImportDeclaration(path) {
            const mod = path.node.source.value;
            for (const importName in IMPORTS) {
              const definition = IMPORTS[importName][ctx.state.mode];
              if (definition.source === mod) {
                registerImportDefinition(ctx.state, path, definition);
              }
            }
          }
        });
      },
      CallExpression(path, ctx) {
        transformBlock(ctx.state, path);
      },
    },
  };
}