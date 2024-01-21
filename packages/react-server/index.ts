import {
  Fragment,
  createElement,
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { ForwardedRef , ReactPortal, ComponentType , JSX } from 'react';
import { RENDER_SCOPE, SVG_RENDER_SCOPE } from '../react/constants';
import type { MillionArrayProps, MillionProps, Options, MillionPortal } from '../types';
import { renderReactScope } from '../react/utils';

export { renderReactScope } from '../react/utils';

let globalInfo;

export const block = <P extends MillionProps>(
  Component: ComponentType<P>,
  options: Options<P> = {}
) => {
  let blockFactory = globalInfo ? globalInfo.block(Component, options) : null;

  const rscBoundary = options.rsc
    ? createRSCBoundary(Component, options.svg)
    : null;

  function MillionBlockLoader<P extends MillionProps>(props?: P) {
    const ref = useRef<HTMLElement>(null);
    const patch = useRef<((props: P) => void) | null>(null);

    const effect = useCallback(() => {
      const init = (): void => {
        const el = ref.current;

        if (!el) return;

        const currentBlock = blockFactory(props, props?.key);

        globalInfo.mount(currentBlock, el, el.firstChild);
        patch.current = (newProps: P) => {
          globalInfo.patch(currentBlock, blockFactory(newProps, newProps.key));
        };
      };

      if (blockFactory && globalInfo) {
        init();
      } else {
        importSource(() => {
          blockFactory = globalInfo.block(
            Component,
            globalInfo.unwrap,
            options.shouldUpdate,
            options.svg
          );

          init();
        });
      }

      return () => {
        blockFactory = null;
      };
    }, []);

    patch.current?.(props!);

    const vnode = createElement(
      Fragment,
      null,
      createElement(Effect, { effect }),
      rscBoundary
        ? createElement(rscBoundary, { ...props, ref } as any)
        : createSSRBoundary<P>(Component as any, props!, ref, options.svg)
    );
    return vnode;
  }

  // TODO add dev guard
  if (options.name) {
    Component.displayName = `Render(Million(${options.name}))`;
    MillionBlockLoader.displayName = `Block(Million(${options.name}))`;
  }

  return MillionBlockLoader;
};

export function For<T>({ each, children, ssr, svg }: MillionArrayProps<T>) {
  const [ready, setReady] = useState(Boolean(globalInfo));

  useEffect(() => {
    if (!globalInfo) {
      importSource(() => {
        setReady(true);
      });
    }
  }, []);

  if (!ready || !globalInfo) {
    if (ssr === false) return null;
    return createElement(
      svg ? SVG_RENDER_SCOPE : RENDER_SCOPE,
      { suppressHydrationWarning: true },
      ...each.map(children)
    );
  }

  return createElement(globalInfo.For, {
    each,
    children,
    ssr,
    svg,
  });
}

function Effect({ effect }: { effect: () => void }) {
  useEffect(effect, []);
  return null;
}

export const importSource = (callback: () => void) => {
  void import('../react')
    .then(({ unwrap, INTERNALS, For }) => {
      globalInfo = {
        unwrap,
        For,
        ...INTERNALS,
      };

      callback();
    })
    .catch(() => {
      throw new Error('Failed to load Million.js');
    });
};

export const createSSRBoundary = <P extends MillionProps>(
  Component: ComponentType<P>,
  props: P,
  ref: ForwardedRef<unknown>,
  svg = false
) => {
  const ssrProps =
    typeof window === 'undefined'
      ? {
          children: createElement<P>(Component, props),
        }
      : { dangerouslySetInnerHTML: { __html: '' } };

  return createElement(svg ? SVG_RENDER_SCOPE : RENDER_SCOPE, {
    suppressHydrationWarning: true,
    ref,
    ...ssrProps,
  });
};

export const createRSCBoundary = <P extends MillionProps>(
  Component: ComponentType<P>,
  svg = false
) => {
  return memo(
    forwardRef((props: P, ref) =>
      createSSRBoundary(Component, props, ref, svg)
    ),
    () => true
  );
};

interface CompiledBlockProps extends MillionProps {
  v: unknown[];
}

function isEqual(a: unknown, b: unknown): boolean {
  // Faster than Object.is
  // eslint-disable-next-line no-self-compare
  return a === b || (a !== a && b !== b);
}

function areCompiledBlockPropsEqual(prev: CompiledBlockProps, next: CompiledBlockProps): boolean {
  for (let i = 0, len = prev.v.length; i < len; i++) {
    if (!isEqual(prev.v[i], next.v[i])) {
      return false;
    }
  }
  return true;
}

interface CompiledBlockOptions extends Omit<Options<CompiledBlockProps>, 'shouldUpdate'> {
  portals: number[];
}

// TODO Fix SSR
export function compiledBlock(
  render: (values: unknown[]) => JSX.Element,
  { portals, ...options }: CompiledBlockOptions,
): ComponentType<CompiledBlockProps> {
  const RenderBlock = block<CompiledBlockProps>((props) => render(props.v), {
    ...options,
    name: `Inner(CompiledBlock(${options.name}))`,
    shouldUpdate: areCompiledBlockPropsEqual,
  });

  const portalCount = portals.length;

  const Component: ComponentType<CompiledBlockProps> = portalCount > 0 ? (props: CompiledBlockProps) => {
    const [current] = useState<MillionPortal[]>(() => []);

    const derived = [...props.v];

    for (let i = 0; i < portalCount; i++) {
      const index = portals[i]!;
      derived[index] = renderReactScope(
        derived[index] as JSX.Element,
        false,
        current,
        i,
      );
    }

    const targets: ReactPortal[] = [];

    for (let i = 0, len = current.length; i < len; i++) {
      targets[i] = current[i]!.portal;
    }

    return createElement(Fragment, {}, [
      createElement(RenderBlock, {
        v: derived,
      }),
      targets,
    ]);
  } : (props: CompiledBlockProps) => createElement(RenderBlock, {
    v: props.v,
  });

  // TODO dev mode
  if (options.name) {
    Component.displayName = `Outer(CompiledBlock(Million(${options.name})))`;
  }

  return Component;
}