import * as t from '@babel/types';
import type { StateContext } from "./types";
import { unwrapNode } from "./utils/unwrap-node";
import { JSX_SKIP_ANNOTATION, SKIP_ANNOTATION } from './constants';
import { findComment } from './utils/ast';
import { isComponent, isComponentishName, isPathValid } from './utils/checks';
import { unwrapPath } from './utils/unwrap-path';
import { getImportIdentifier } from './utils/get-import-specifier';
import { HIDDEN_IMPORTS, IMPORTS } from './constants.new';
import { getDescriptiveName } from './utils/get-descriptive-name';
import { generateUniqueName } from './utils/generate-unique-name';
import { getRootStatementPath } from './utils/get-root-statement-path';
import { isGuaranteedLiteral } from './utils/is-guaranteed-literal';

function isValidBlockCall(ctx: StateContext, path: babel.NodePath<t.CallExpression>): boolean {
  // Check for direct identifier usage e.g. import { block }
  const identifier = unwrapNode(path.node.callee, t.isIdentifier);
  if (identifier) {
    const binding = path.scope.getBindingIdentifier(identifier.name);
    const definition = ctx.definitions.identifiers.get(binding);
    if (definition) {
      return IMPORTS.block[ctx.mode] === definition;
    }
    return false;
  }
  // Check for namespace usage e.g. import * as million
  const memberExpr = unwrapNode(path.node.callee, t.isMemberExpression);
  if (memberExpr && !memberExpr.computed && t.isIdentifier(memberExpr.property)) {
    const object = unwrapNode(memberExpr.object, t.isIdentifier);
    if (object) {
      const binding = path.scope.getBindingIdentifier(object.name);
      const propName = memberExpr.property.name;
      const definitions = ctx.definitions.namespaces.get(binding);
      if (definitions) {
        for (let i = 0, len = definitions.length; i < len; i++) {
          const definition = definitions[i]!;
          if (definition.kind === 'named' && definition.name === propName) {
            return IMPORTS.block[ctx.mode] === definition;
          }
        }
      }
    }
  } 
  return false;
}

interface JSXStateContext {
  // The source of array values
  source: t.Identifier;
  // The expressions from the JSX moved into an array
  exprs: t.JSXAttribute[];
  keys: t.Expression[];
}

function pushExpression(
  state: JSXStateContext,
  expr: t.Expression,
): string {
  const key = `v${state.exprs.length}`;
  state.exprs.push(t.jsxAttribute(t.jsxIdentifier(key), t.jsxExpressionContainer(t.cloneNode(expr))));
  return key;
}

function pushExpressionAndReplace(
  state: JSXStateContext,
  target: babel.NodePath<t.Expression>,
  top: boolean,
  portal: boolean,
): void {
  const key = pushExpression(state, target.node);
  const expr = t.memberExpression(state.source, t.identifier(key));
  target.replaceWith(top ? expr : t.jsxExpressionContainer(expr));
  if (portal && !isGuaranteedLiteral(target.node)) {
    state.keys.push(t.stringLiteral(key));
  }
}

function extractJSXExpressionsFromExpression(
  state: JSXStateContext,
  expr: babel.NodePath<t.Expression>,
  portal: boolean,
): void {
  const unwrappedJSX = unwrapPath(expr, t.isJSXElement);
  if (unwrappedJSX) {
    extractJSXExpressions(state, unwrappedJSX, true)
    return;
  }
  const unwrappedFragment = unwrapPath(expr, t.isJSXFragment);
  if (unwrappedFragment) {
    extractJSXExpressions(state, unwrappedFragment, true)
    return;
  }
  // TODO Skip if the value is static
  pushExpressionAndReplace(state, expr, true, portal);
}

function extractJSXExpressionsFromJSXSpreadChild(
  state: JSXStateContext,
  path: babel.NodePath<t.JSXSpreadChild>,
): void {
  extractJSXExpressionsFromExpression(state, path.get('expression'), false);
}

function extractJSXExpressionsFromJSXExpressionContainer(
  state: JSXStateContext,
  path: babel.NodePath<t.JSXExpressionContainer>,
  portal: boolean,
): void {
  const expr = path.get('expression');
  if (isPathValid(expr, t.isExpression)) {
    extractJSXExpressionsFromExpression(state, expr, portal);
  }
}

function extractJSXExpressionsFromJSXAttribute(
  state: JSXStateContext,
  attr: babel.NodePath<t.JSXAttribute>,
): void {
  const value = attr.get('value');
  if (isPathValid(value, t.isJSXElement)) {
    extractJSXExpressions(state, value, false);
  } else if (isPathValid(value, t.isJSXFragment)) {
    extractJSXExpressions(state, value, false);
  } else if (isPathValid(value, t.isJSXExpressionContainer)) {
    extractJSXExpressionsFromJSXExpressionContainer(state, value, false);
  }
}

function extractJSXExpressionsFromJSXSpreadAttribute(
  state: JSXStateContext,
  attr: babel.NodePath<t.JSXSpreadAttribute>,
): void {
  extractJSXExpressionsFromExpression(state, attr.get('argument'), false);
}

function extractJSXExpressionsFromJSXAttributes(
  state: JSXStateContext,
  attrs: babel.NodePath<t.JSXAttribute | t.JSXSpreadAttribute>[],
): void {
  for (let i = 0, len = attrs.length; i < len; i++) {
    const attr = attrs[i];

    if (isPathValid(attr, t.isJSXAttribute)) {
      extractJSXExpressionsFromJSXAttribute(state, attr);
    } else if (isPathValid(attr, t.isJSXSpreadAttribute)) {
      extractJSXExpressionsFromJSXSpreadAttribute(state, attr);
    }
  }
}

function isJSXComponentElement(
  path: babel.NodePath<t.JSXElement>,
): boolean {
  const openingElement = path.get('openingElement');
  const name = openingElement.get('name');
  /**
   * Only valid component elements are member expressions and identifiers
   * starting with component-ish name
   */
  if (isPathValid(name, t.isJSXMemberExpression)) {
    return true;
  }
  if (isPathValid(name, t.isJSXIdentifier)) {
    if (/^[A-Z_]/.test(name.node.name)) {
      return true;
    }
  }
  const attributes = openingElement.get('attributes');
  for (let i = 0, len = attributes.length; i < len; i++) {
    const attr = attributes[i];

    if (isPathValid(attr, t.isJSXAttribute) && attr.node.name.name === 'ref') {
      return true;
    }
  }
  return false;
}

function extractJSXExpressionsFromJSXElement(
  state: JSXStateContext,
  path: babel.NodePath<t.JSXElement>,
  top: boolean,
): boolean {
  const openingElement = path.get('openingElement');
  /**
   * If this is a component element, move the JSX expression
   * to the expression array.
   */
  if (isJSXComponentElement(path)){
    pushExpressionAndReplace(state, path, top, true);
    return true;
  }
  /**
   * Otherwise, continue extracting in attributes
   */
  extractJSXExpressionsFromJSXAttributes(state, openingElement.get('attributes'));
  return false;
}

function extractJSXExpressions(
  state: JSXStateContext,
  path: babel.NodePath<t.JSXElement | t.JSXFragment>,
  top: boolean,
): void {
  /**
   * Check if JSX should be skipped for children extraction
   * We only do this since Component elements
   * cannot be in the compiledBlock JSX
   */
  if (isPathValid(path, t.isJSXElement) && extractJSXExpressionsFromJSXElement(state, path, top)) {
    return;
  }
  const children = path.get('children');
  for (let i = 0, len = children.length; i < len; i++) {
    const child = children[i];

    if (isPathValid(child, t.isJSXElement)) {
      extractJSXExpressions(state, child, false);
    } else if (isPathValid(child, t.isJSXFragment)) {
      extractJSXExpressions(state, child, false);
    } else if (isPathValid(child, t.isJSXSpreadChild)) {
      extractJSXExpressionsFromJSXSpreadChild(state, child);
    } else if (isPathValid(child, t.isJSXExpressionContainer)) {
      extractJSXExpressionsFromJSXExpressionContainer(state, child, true);
    }
  }
}

function transformJSX(ctx: StateContext, path: babel.NodePath<t.JSXElement | t.JSXFragment>): void {
  /**
   * For top-level JSX, we skip at elements that are constructed from components
   */
  // if (isPathValid(path, t.isJSXElement) && isJSXComponentElement(path)) {
  if (findComment(path.node, JSX_SKIP_ANNOTATION)) {
    path.skip();
    return;
  }
  const state: JSXStateContext = {
    source: path.scope.generateUidIdentifier('props'),
    exprs: [],
    keys: [],
  };

  /**
   * Begin extracting expressions/portals
   */
  extractJSXExpressions(state, path, !(
    isPathValid(path.parentPath, t.isJSXElement)
    || isPathValid(path.parentPath, t.isJSXFragment)
    || isPathValid(path.parentPath, t.isJSXAttribute)
  ));

  /**
   * Get the nearest descriptive name
   */
  const descriptiveName = getDescriptiveName(path, 'Anonymous');
  /**
   * Generate a new name based on the descriptive name
   */
  const id = generateUniqueName(
    path,
    isComponentishName(descriptiveName)
      ? descriptiveName
      : `JSX_${descriptiveName}`,
  );
  /**
   * The following are arguments for the new render function
   */
  const args: t.Identifier[] = [];

  /**
   * If there are any extracted expressions, declare the argument
   */
  if (state.exprs.length) {
    args.push(state.source);
  } else {
    path.scope.removeBinding(state.source.name);
  }

  /**
   * The new "render" function
   */
  const newComponent = t.arrowFunctionExpression(
    args,
    path.node,
  );

  /**
   * Following are the `compiledBlock` options
   */
  const options = [
    // TODO add dev mode
    t.objectProperty(
      t.identifier('name'),
      t.stringLiteral(id.name),
    ),
  ];

  /**
   * If there are any portals, declare them in the options
   */
  if (state.keys.length) {
    options.push(t.objectProperty(
      t.identifier('portals'),
      t.arrayExpression(state.keys),
    ));
  }

  /**
   * Generate the new compiledBlock
   */
  const generatedBlock = t.variableDeclaration(
    'const',
    [t.variableDeclarator(id, t.callExpression(
      getImportIdentifier(ctx, path, HIDDEN_IMPORTS.compiledBlock[ctx.mode]),
      [
        newComponent,
        t.objectExpression(options),
      ],
    ))],
  );

  const rootPath = getRootStatementPath(path);
  rootPath.insertBefore(generatedBlock);

  path.replaceWith(
    t.addComment(
      t.jsxElement(
        t.jsxOpeningElement(t.jsxIdentifier(id.name), state.exprs, true),
        t.jsxClosingElement(t.jsxIdentifier(id.name)),
        [],
        true,
      ),
      'leading',
      JSX_SKIP_ANNOTATION,
    ),
  );
}

export function transformBlock(ctx: StateContext, path: babel.NodePath<t.CallExpression>): void {
  // Check first if the call is a valid `block` call
  if (!isValidBlockCall(ctx, path)) {
    return;
  }
  // Check if we should skip because the compiler
  // can also output a `block` call. Without this,
  // compiler will suffer a recursion.
  if (findComment(path.node, SKIP_ANNOTATION)) {
    return;
  }
  const args = path.get('arguments');
  // Make sure that we have at least one argument,
  // and that argument is a component.
  if (args.length <= 0) {
    return;
  }
  const identifier = unwrapPath(args[0]!, t.isIdentifier);
  // Handle identifiers differently
  if (identifier) {
    return;
  }
  const component = unwrapPath(args[0]!, isComponent);
  if (!component) {
    return;
  }
  // Transform all top-level JSX (aka the JSX owned by the component)
  component.traverse({
    JSXElement(childPath) {
      const functionParent = childPath.getFunctionParent();
      if (functionParent === component) {
        transformJSX(ctx, childPath);
      }
    },
    JSXFragment(childPath) {
      const functionParent = childPath.getFunctionParent();
      if (functionParent === component) {
        transformJSX(ctx, childPath);
      }
    },
  });

  if (isPathValid(component, t.isArrowFunctionExpression) && t.isExpression(component.node.body)) {
    const root = getRootStatementPath(component);
    const descriptiveName = getDescriptiveName(component, 'Anonymous');
    const uniqueName = generateUniqueName(
      component, 
      isComponentishName(descriptiveName)
        ? descriptiveName
        : `JSX_${descriptiveName}`,
    );

    root.insertBefore([
      t.variableDeclaration('const', [
        t.variableDeclarator(uniqueName, component.node),
      ]),
      t.expressionStatement(
        t.assignmentExpression(
          '=',
          t.memberExpression(
            uniqueName,
            t.identifier('_c'),
          ),
          t.booleanLiteral(true),
        ),
      ),
    ]);
    path.replaceWith(uniqueName);
  } else {
    path.replaceWith(component);
  }
}