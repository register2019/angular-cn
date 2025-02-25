/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {HashLocationStrategy, Location, LocationStrategy, PathLocationStrategy, ViewportScroller} from '@angular/common';
import {APP_BOOTSTRAP_LISTENER, ComponentRef, inject, Inject, InjectionToken, ModuleWithProviders, NgModule, NgProbeToken, NgZone, Optional, Provider, SkipSelf, ɵRuntimeError as RuntimeError} from '@angular/core';

import {EmptyOutletComponent} from './components/empty_outlet';
import {RouterLink} from './directives/router_link';
import {RouterLinkActive} from './directives/router_link_active';
import {RouterOutlet} from './directives/router_outlet';
import {RuntimeErrorCode} from './errors';
import {Routes} from './models';
import {getBootstrapListener, rootRoute, ROUTER_IS_PROVIDED, withDebugTracing, withDisabledInitialNavigation, withEnabledBlockingInitialNavigation, withPreloading} from './provide_router';
import {Router, setupRouter} from './router';
import {ExtraOptions, ROUTER_CONFIGURATION} from './router_config';
import {RouterConfigLoader, ROUTES} from './router_config_loader';
import {ChildrenOutletContexts} from './router_outlet_context';
import {ROUTER_SCROLLER, RouterScroller} from './router_scroller';
import {ActivatedRoute} from './router_state';
import {DefaultUrlSerializer, UrlSerializer} from './url_tree';

const NG_DEV_MODE = typeof ngDevMode === 'undefined' || ngDevMode;

/**
 * The directives defined in the `RouterModule`.
 *
 * `RouterModule` 中定义的指令。
 *
 */
const ROUTER_DIRECTIVES = [RouterOutlet, RouterLink, RouterLinkActive, EmptyOutletComponent];

/**
 * @docsNotRequired
 */
export const ROUTER_FORROOT_GUARD = new InjectionToken<void>(
    NG_DEV_MODE ? 'router duplicate forRoot guard' : 'ROUTER_FORROOT_GUARD');

// TODO(atscott): All of these except `ActivatedRoute` are `providedIn: 'root'`. They are only kept
// here to avoid a breaking change whereby the provider order matters based on where the
// `RouterModule`/`RouterTestingModule` is imported. These can/should be removed as a "breaking"
// change in a major version.
export const ROUTER_PROVIDERS: Provider[] = [
  Location,
  {provide: UrlSerializer, useClass: DefaultUrlSerializer},
  {provide: Router, useFactory: setupRouter},
  ChildrenOutletContexts,
  {provide: ActivatedRoute, useFactory: rootRoute, deps: [Router]},
  RouterConfigLoader,
  // Only used to warn when `provideRoutes` is used without `RouterModule` or `provideRouter`. Can
  // be removed when `provideRoutes` is removed.
  NG_DEV_MODE ? {provide: ROUTER_IS_PROVIDED, useValue: true} : [],
];

export function routerNgProbeToken() {
  return new NgProbeToken('Router', Router);
}

/**
 * @description
 *
 * Adds directives and providers for in-app navigation among views defined in an application.
 * Use the Angular `Router` service to declaratively specify application states and manage state
 * transitions.
 *
 * 添加指令和提供者，以便在应用程序中定义的视图之间进行应用内导航。使用 Angular `Router`
 * 服务以声明方式指定应用程序状态并管理状态转换。
 *
 * You can import this NgModule multiple times, once for each lazy-loaded bundle.
 * However, only one `Router` service can be active.
 * To ensure this, there are two ways to register routes when importing this module:
 *
 * 你可以多次导入此 NgModule，对于每个惰性加载的包导入一次。但是，只能有一个 `Router`
 * 服务是活动的。为确保这一点，在导入此模块时有两种方法来注册路由：
 *
 * * The `forRoot()` method creates an `NgModule` that contains all the directives, the given
 *   routes, and the `Router` service itself.
 *
 *   `forRoot()` 方法会创建一个 `NgModule`，其中包含所有指令、给定的路由以及 `Router` 服务本身。
 *
 * * The `forChild()` method creates an `NgModule` that contains all the directives and the given
 *     routes, but does not include the `Router` service.
 *
 *   `forChild()` 方法会创建一个 `NgModule`，其中包含所有指令和给定的路由，但不包括 `Router`
 *   服务。
 *
 * @see [Routing and Navigation guide](guide/router) for an
 * overview of how the `Router` service should be used.
 *
 * [路由和导航指南](guide/router)，概述了应如何使用 `Router` 服务。
 * @see [路由与导航](guide/router.html) 以获得如何使用路由器服务的概览。
 * @publicApi
 */
@NgModule({
  imports: ROUTER_DIRECTIVES,
  exports: ROUTER_DIRECTIVES,
})
export class RouterModule {
  constructor(@Optional() @Inject(ROUTER_FORROOT_GUARD) guard: any) {}

  /**
   * Creates and configures a module with all the router providers and directives.
   * Optionally sets up an application listener to perform an initial navigation.
   *
   * 带着所有路由器提供者和指令创建和配置模块。（可选）设置应用程序监听器以执行初始导航。
   *
   * When registering the NgModule at the root, import as follows:
   *
   * 在根目录下注册 NgModule 时，请按以下方式导入：
   *
   * ```
   * @NgModule({
   *   imports: [RouterModule.forRoot(ROUTES)]
   * })
   * class MyNgModule {}
   * ```
   *
   * @param routes An array of `Route` objects that define the navigation paths for the application.
   *
   * `Route` 对象的数组，这些对象定义应用程序的导航路径。
   * @param config An `ExtraOptions` configuration object that controls how navigation is performed.
   *
   * 一个 `ExtraOptions` 配置对象，该对象会控制如何执行导航。
   * @return The new `NgModule`.
   *
   * 新的 `NgModule` 。
   */
  static forRoot(routes: Routes, config?: ExtraOptions): ModuleWithProviders<RouterModule> {
    return {
      ngModule: RouterModule,
      providers: [
        ROUTER_PROVIDERS,
        NG_DEV_MODE ? (config?.enableTracing ? withDebugTracing().ɵproviders : []) : [],
        {provide: ROUTES, multi: true, useValue: routes},
        {
          provide: ROUTER_FORROOT_GUARD,
          useFactory: provideForRootGuard,
          deps: [[Router, new Optional(), new SkipSelf()]]
        },
        {provide: ROUTER_CONFIGURATION, useValue: config ? config : {}},
        config?.useHash ? provideHashLocationStrategy() : providePathLocationStrategy(),
        provideRouterScroller(),
        config?.preloadingStrategy ? withPreloading(config.preloadingStrategy).ɵproviders : [],
        {provide: NgProbeToken, multi: true, useFactory: routerNgProbeToken},
        config?.initialNavigation ? provideInitialNavigation(config) : [],
        provideRouterInitializer(),
      ],
    };
  }

  /**
   * Creates a module with all the router directives and a provider registering routes,
   * without creating a new Router service.
   * When registering for submodules and lazy-loaded submodules, create the NgModule as follows:
   *
   * 创建带有所有路由器指令和提供者注册的路由的模块，而无需创建新的路由器服务。注册子模块和惰性加载的子模块时，像这样创建
   * NgModule：
   *
   * ```
   * @NgModule({
   *   imports: [RouterModule.forChild(ROUTES)]
   * })
   * class MyNgModule {}
   * ```
   *
   * @param routes An array of `Route` objects that define the navigation paths for the submodule.
   *
   * `Route` 对象的数组，它们定义了子模块的导航路径。
   * @return The new NgModule.
   *
   * 新的 NgModule。
   */
  static forChild(routes: Routes): ModuleWithProviders<RouterModule> {
    return {
      ngModule: RouterModule,
      providers: [{provide: ROUTES, multi: true, useValue: routes}],
    };
  }
}

/**
 * For internal use by `RouterModule` only. Note that this differs from `withInMemoryRouterScroller`
 * because it reads from the `ExtraOptions` which should not be used in the standalone world.
 *
 * 仅供 `RouterModule` 内部使用。请注意，这与 `withInMemoryRouterScroller`
 * 不同，因为它是从不应该在独立世界中使用的 `ExtraOptions` 中读取的。
 *
 */
export function provideRouterScroller(): Provider {
  return {
    provide: ROUTER_SCROLLER,
    useFactory: () => {
      const router = inject(Router);
      const viewportScroller = inject(ViewportScroller);
      const zone = inject(NgZone);
      const config: ExtraOptions = inject(ROUTER_CONFIGURATION);
      if (config.scrollOffset) {
        viewportScroller.setOffset(config.scrollOffset);
      }
      return new RouterScroller(router, viewportScroller, zone, config);
    },
  };
}

// Note: For internal use only with `RouterModule`. Standalone setup via `provideRouter` should
// provide hash location directly via `{provide: LocationStrategy, useClass: HashLocationStrategy}`.
function provideHashLocationStrategy(): Provider {
  return {provide: LocationStrategy, useClass: HashLocationStrategy};
}

// Note: For internal use only with `RouterModule`. Standalone setup via `provideRouter` does not
// need this at all because `PathLocationStrategy` is the default factory for `LocationStrategy`.
function providePathLocationStrategy(): Provider {
  return {provide: LocationStrategy, useClass: PathLocationStrategy};
}

export function provideForRootGuard(router: Router): any {
  if (NG_DEV_MODE && router) {
    throw new RuntimeError(
        RuntimeErrorCode.FOR_ROOT_CALLED_TWICE,
        `The Router was provided more than once. This can happen if 'forRoot' is used outside of the root injector.` +
            ` Lazy loaded modules should use RouterModule.forChild() instead.`);
  }
  return 'guarded';
}

// Note: For internal use only with `RouterModule`. Standalone router setup with `provideRouter`
// users call `withXInitialNavigation` directly.
function provideInitialNavigation(config: Pick<ExtraOptions, 'initialNavigation'>): Provider[] {
  return [
    config.initialNavigation === 'disabled' ? withDisabledInitialNavigation().ɵproviders : [],
    config.initialNavigation === 'enabledBlocking' ?
        withEnabledBlockingInitialNavigation().ɵproviders :
        [],
  ];
}

// TODO(atscott): This should not be in the public API
/**
 * A [DI token](guide/glossary/#di-token) for the router initializer that
 * is called after the app is bootstrapped.
 *
 * 一个代表路由器初始化器的令牌，应用引导完毕后就会调用它。
 *
 * @publicApi
 */
export const ROUTER_INITIALIZER = new InjectionToken<(compRef: ComponentRef<any>) => void>(
    NG_DEV_MODE ? 'Router Initializer' : '');

function provideRouterInitializer(): Provider[] {
  return [
    // ROUTER_INITIALIZER token should be removed. It's public API but shouldn't be. We can just
    // have `getBootstrapListener` directly attached to APP_BOOTSTRAP_LISTENER.
    {provide: ROUTER_INITIALIZER, useFactory: getBootstrapListener},
    {provide: APP_BOOTSTRAP_LISTENER, multi: true, useExisting: ROUTER_INITIALIZER},
  ];
}
