/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {DOCUMENT, ɵgetDOM as getDOM} from '@angular/common';
import {APP_INITIALIZER, ApplicationInitStatus, InjectionToken, Injector, StaticProvider} from '@angular/core';

/**
 * An id that identifies a particular application being bootstrapped, that should
 * match across the client/server boundary.
 *
 * 一个 id，用于标识正在被引导的特定应用程序，应该跨客户端/服务器边界匹配。
 *
 */
export const TRANSITION_ID = new InjectionToken('TRANSITION_ID');

export function appInitializerFactory(transitionId: string, document: any, injector: Injector) {
  return () => {
    // Wait for all application initializers to be completed before removing the styles set by
    // the server.
    injector.get(ApplicationInitStatus).donePromise.then(() => {
      const dom = getDOM();
      const styles: HTMLCollectionOf<HTMLStyleElement> =
          document.querySelectorAll(`style[ng-transition="${transitionId}"]`);
      for (let i = 0; i < styles.length; i++) {
        dom.remove(styles[i]);
      }
    });
  };
}

export const SERVER_TRANSITION_PROVIDERS: StaticProvider[] = [
  {
    provide: APP_INITIALIZER,
    useFactory: appInitializerFactory,
    deps: [TRANSITION_ID, DOCUMENT, Injector],
    multi: true
  },
];
