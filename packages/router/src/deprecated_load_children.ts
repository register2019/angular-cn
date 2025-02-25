/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {Injector, NgModuleFactory} from '@angular/core';
import {Observable} from 'rxjs';

// This file exists to support the legacy `loadChildren: string` behavior being patched back into
// Angular.

/**
 * Deprecated `loadChildren` value types.
 *
 * 不推荐使用 `loadChildren` 值类型。
 *
 * @publicApi
 * @deprecated
 *
 * represents the deprecated type side of `LoadChildren`.
 *
 * 表示 `LoadChildren` 的不推荐使用的类型。
 *
 */
export type DeprecatedLoadChildren = never;

export function deprecatedLoadChildrenString(
    injector: Injector, loadChildren: unknown): Observable<NgModuleFactory<any>>|null {
  return null;
}
