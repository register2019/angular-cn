/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {LanguageServiceTestEnv} from './env';
import {Project, ProjectFiles, TestableOptions} from './project';

/**
 * Expect that a list of objects with a `fileName` property matches a set of expected files by only
 * comparing the file names and not any path prefixes.
 *
 * 期望具有 `fileName` 属性的对象列表与一组预期文件匹配，方法是仅比较文件名而不比较任何路径前缀。
 *
 * This assertion is independent of the order of either list.
 *
 * 此断言与任一列表的顺序无关。
 *
 */
export function assertFileNames(refs: Array<{fileName: string}>, expectedFileNames: string[]) {
  const actualPaths = refs.map(r => r.fileName);
  const actualFileNames = actualPaths.map(p => last(p.split('/')));
  expect(new Set(actualFileNames)).toEqual(new Set(expectedFileNames));
}

export function assertTextSpans(items: Array<{textSpan: string}>, expectedTextSpans: string[]) {
  const actualSpans = items.map(item => item.textSpan);
  expect(new Set(actualSpans)).toEqual(new Set(expectedTextSpans));
}

/**
 * Returns whether the given `ts.Diagnostic` is of a type only produced by the Angular compiler (as
 * opposed to being an upstream TypeScript diagnostic).
 *
 * 返回给定的 `ts.Diagnostic` 是否属于仅由 Angular 编译器生成的类型（而不是上游的 TypeScript
 * 诊断）。
 *
 * Template type-checking diagnostics are not "ng-specific" in this sense, since they are plain
 * TypeScript diagnostics that are produced from expressions in the template by way of a TCB.
 *
 * 从这个意义上说，模板类型检查诊断不是“特定于 ng 的”，因为它们是普通的 TypeScript 诊断，是通过 TCB
 * 从模板中的表达式生成的。
 *
 */
export function isNgSpecificDiagnostic(diag: ts.Diagnostic): boolean {
  // Angular-specific diagnostics use a negative code space.
  return diag.code < 0;
}

function getFirstClassDeclaration(declaration: string) {
  const matches = declaration.match(/(?:export class )(\w+)(?:\s|\{|<)/);
  if (matches === null || matches.length !== 2) {
    throw new Error(`Did not find exactly one exported class in: ${declaration}`);
  }
  return matches[1].trim();
}

export function createModuleAndProjectWithDeclarations(
    env: LanguageServiceTestEnv, projectName: string, projectFiles: ProjectFiles,
    options: TestableOptions = {}, standaloneFiles: ProjectFiles = {}): Project {
  const externalClasses: string[] = [];
  const externalImports: string[] = [];
  for (const [fileName, fileContents] of Object.entries(projectFiles)) {
    if (!fileName.endsWith('.ts')) {
      continue;
    }
    const className = getFirstClassDeclaration(fileContents);
    externalClasses.push(className);
    externalImports.push(`import {${className}} from './${fileName.replace('.ts', '')}';`);
  }
  const moduleContents = `
        import {NgModule} from '@angular/core';
        import {CommonModule} from '@angular/common';
        ${externalImports.join('\n')}

        @NgModule({
          declarations: [${externalClasses.join(',')}],
          imports: [CommonModule],
        })
        export class AppModule {}
      `;
  projectFiles['app-module.ts'] = moduleContents;
  return env.addProject(projectName, {...projectFiles, ...standaloneFiles}, options);
}

export function humanizeDocumentSpanLike<T extends ts.DocumentSpan>(
    item: T, env: LanguageServiceTestEnv): T&Stringy<ts.DocumentSpan> {
  return {
    ...item,
    textSpan: env.getTextFromTsSpan(item.fileName, item.textSpan),
    contextSpan: item.contextSpan ? env.getTextFromTsSpan(item.fileName, item.contextSpan) :
                                    undefined,
    originalTextSpan: item.originalTextSpan ?
        env.getTextFromTsSpan(item.fileName, item.originalTextSpan) :
        undefined,
    originalContextSpan: item.originalContextSpan ?
        env.getTextFromTsSpan(item.fileName, item.originalContextSpan) :
        undefined,
  };
}
type Stringy<T> = {
  [P in keyof T]: string;
};

export function getText(contents: string, textSpan: ts.TextSpan) {
  return contents.slice(textSpan.start, textSpan.start + textSpan.length);
}

function last<T>(array: T[]): T {
  if (array.length === 0) {
    throw new Error(`last() called on empty array`);
  }
  return array[array.length - 1];
}
