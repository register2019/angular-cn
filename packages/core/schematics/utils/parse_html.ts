/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import type {TmplAstNode} from '@angular/compiler';

/**
 * Parses the given HTML content using the Angular compiler. In case the parsing
 * fails, null is being returned.
 *
 * 使用 Angular 编译器解析给定的 HTML 内容。如果解析失败，则会返回 null 。
 *
 */
export function parseHtmlGracefully(
    htmlContent: string, filePath: string,
    compilerModule: typeof import('@angular/compiler')): TmplAstNode[]|null {
  try {
    return compilerModule.parseTemplate(htmlContent, filePath).nodes;
  } catch {
    // Do nothing if the template couldn't be parsed. We don't want to throw any
    // exception if a template is syntactically not valid. e.g. template could be
    // using preprocessor syntax.
    return null;
  }
}
