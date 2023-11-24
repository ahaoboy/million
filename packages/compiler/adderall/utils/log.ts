import * as t from '@babel/types';
import { bold, cyan, dim, magenta } from 'kleur';
import type { Options } from '../../options';
import type { NodePath } from '@babel/core';

/**
 * deopt (deoptimize) will turn a block into a regular function call.
 */
export const deopt = (
  message: string | null,
  file: string,
  callSitePath: NodePath,
  targetPath: NodePath = callSitePath,
) => {
  const { parent, node } = callSitePath;
  // This will attempt to reset the variable to the first argument from
  // const foo = block(Component) --> const foo = Component
  if (
    t.isVariableDeclarator(parent) &&
    'arguments' in node &&
    (t.isExpression(node.arguments[0]) || t.isIdentifier(node.arguments[0]))
  ) {
    parent.init = node.arguments[0];
  }
  if (message === null) return new Error('');
  return createErrorMessage(targetPath, message, file);
};

export const createErrorMessage = (
  path: NodePath,
  message: string,
  file: string,
) => {
  return path.buildCodeFrameError(`\n${magenta('⚠')}${message} ${dim(file)}`);
};

let hasIntroRan = false;

export const displayIntro = (options: Options) => {
  if (hasIntroRan) return;
  hasIntroRan = true;

  const experiments: string[] = [];

  if (typeof options.auto === 'object' && options.auto.rsc) {
    experiments.push('auto-rsc');
  }
  if (options.optimize) {
    experiments.push('optimize');
  }

  let message = `\n  ${bold(
    magenta(`⚡ Million.js ${process.env.VERSION || ''}`),
  )}
  - Tip:     use ${dim('// million-ignore')} for errors
  - Hotline: ${cyan('https://million.dev/hotline')}`;

  if (experiments.length) {
    message += `\n  - Experiments (use at your own risk):
      · ${experiments.join('\n      · ')}
  `;
  }

  // eslint-disable-next-line no-console
  console.log(`${message}\n`);
};

export const catchError = (
  fn: () => void,
  mute: boolean | string | undefined | null,
) => {
  try {
    fn();
  } catch (err: unknown) {
    if (err instanceof Error && err.message && !mute) {
      // eslint-disable-next-line no-console
      console.warn(err.message, '\n');
    }
  }
};
