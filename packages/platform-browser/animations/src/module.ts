/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {ModuleWithProviders, NgModule, Provider} from '@angular/core';
import {BrowserModule} from '@angular/platform-browser';

import {BROWSER_ANIMATIONS_PROVIDERS, BROWSER_NOOP_ANIMATIONS_PROVIDERS} from './providers';

/**
 * Object used to configure the behavior of {@link BrowserAnimationsModule}
 *
 * 用于配置 {@link BrowserAnimationsModule} 行为的对象
 *
 * @publicApi
 */
export interface BrowserAnimationsModuleConfig {
  /**
   * Whether animations should be disabled. Passing this is identical to providing the
   * `NoopAnimationsModule`, but it can be controlled based on a runtime value.
   *
   * 是否应禁用动画。传递它与提供 `NoopAnimationsModule` 相同，但它可以根据运行时值进行控制。
   *
   */
  disableAnimations?: boolean;
}

/**
 * Exports `BrowserModule` with additional [dependency-injection providers](guide/glossary#provider)
 * for use with animations. See [Animations](guide/animations).
 *
 * 导出带有附加[依赖项注入提供者](guide/glossary#provider) 的 `BrowserModule`
 * 以便与动画一起使用。请参阅[动画](guide/animations)。
 *
 * @publicApi
 */
@NgModule({
  exports: [BrowserModule],
  providers: BROWSER_ANIMATIONS_PROVIDERS,
})
export class BrowserAnimationsModule {
  /**
   * Configures the module based on the specified object.
   *
   * 根据指定的对象配置模块。
   *
   * @param config Object used to configure the behavior of the `BrowserAnimationsModule`.
   *
   * 用于配置 `BrowserAnimationsModule` 行为的对象。
   * @see `BrowserAnimationsModuleConfig`
   * @usageNotes
   *
   * When registering the `BrowserAnimationsModule`, you can use the `withConfig`
   * function as follows:
   *
   * 注册 `BrowserAnimationsModule` 时，你可以用 `withConfig` 函数，如下所示：
   *
   * ```
   * @NgModule({
   *   imports: [BrowserAnimationsModule.withConfig(config)]
   * })
   * class MyNgModule {}
   * ```
   *
   */
  static withConfig(config: BrowserAnimationsModuleConfig):
      ModuleWithProviders<BrowserAnimationsModule> {
    return {
      ngModule: BrowserAnimationsModule,
      providers: config.disableAnimations ? BROWSER_NOOP_ANIMATIONS_PROVIDERS :
                                            BROWSER_ANIMATIONS_PROVIDERS
    };
  }
}

/**
 * Returns the set of [dependency-injection providers](guide/glossary#provider)
 * to enable animations in an application. See [animations guide](guide/animations)
 * to learn more about animations in Angular.
 *
 * @usageNotes
 *
 * The function is useful when you want to enable animations in an application
 * bootstrapped using the `bootstrapApplication` function. In this scenario there
 * is no need to import the `BrowserAnimationsModule` NgModule at all, just add
 * providers returned by this function to the `providers` list as show below.
 *
 * ```typescript
 * bootstrapApplication(RootComponent, {
 *   providers: [
 *     provideAnimations()
 *   ]
 * });
 * ```
 *
 * @publicApi
 */
export function provideAnimations(): Provider[] {
  // Return a copy to prevent changes to the original array in case any in-place
  // alterations are performed to the `provideAnimations` call results in app code.
  return [...BROWSER_ANIMATIONS_PROVIDERS];
}

/**
 * A null player that must be imported to allow disabling of animations.
 *
 * 必须导入一个空播放器以支持禁用动画。
 *
 * @publicApi
 */
@NgModule({
  exports: [BrowserModule],
  providers: BROWSER_NOOP_ANIMATIONS_PROVIDERS,
})
export class NoopAnimationsModule {
}

/**
 * Returns the set of [dependency-injection providers](guide/glossary#provider)
 * to disable animations in an application. See [animations guide](guide/animations)
 * to learn more about animations in Angular.
 *
 * @usageNotes
 *
 * The function is useful when you want to bootstrap an application using
 * the `bootstrapApplication` function, but you need to disable animations
 * (for example, when running tests).
 *
 * ```typescript
 * bootstrapApplication(RootComponent, {
 *   providers: [
 *     provideNoopAnimations()
 *   ]
 * });
 * ```
 *
 * @publicApi
 */
export function provideNoopAnimations(): Provider[] {
  // Return a copy to prevent changes to the original array in case any in-place
  // alterations are performed to the `provideNoopAnimations` call results in app code.
  return [...BROWSER_NOOP_ANIMATIONS_PROVIDERS];
}
