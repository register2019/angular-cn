/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {getFileSystem} from '@angular/compiler-cli/src/ngtsc/file_system';
import {MockFileSystem} from '@angular/compiler-cli/src/ngtsc/file_system/testing';
import {loadStandardTestFiles} from '@angular/compiler-cli/src/ngtsc/testing';
import * as ts from 'typescript/lib/tsserverlibrary';

import {MockServerHost} from './host';
import {Project, ProjectFiles, TestableOptions} from './project';

/**
 * Testing environment for the Angular Language Service, which creates an in-memory tsserver
 * instance that backs a Language Service to emulate an IDE that uses the LS.
 *
 * Angular 语言服务的测试环境，它创建了一个支持语言服务的内存中 tsserver 实例以模拟使用 LS 的 IDE。
 *
 */
export class LanguageServiceTestEnv {
  static setup(): LanguageServiceTestEnv {
    const fs = getFileSystem();
    if (!(fs instanceof MockFileSystem)) {
      throw new Error(`LanguageServiceTestEnvironment only works with a mock filesystem`);
    }
    fs.init(loadStandardTestFiles({
      fakeCore: true,
      fakeCommon: true,
    }));

    const host = new MockServerHost(fs);

    const projectService = new ts.server.ProjectService({
      logger,
      cancellationToken: ts.server.nullCancellationToken,
      host,
      typingsInstaller: ts.server.nullTypingsInstaller,
      session: undefined,
      useInferredProjectPerProjectRoot: true,
      useSingleInferredProject: true,
    });

    return new LanguageServiceTestEnv(host, projectService);
  }

  private projects = new Map<string, Project>();

  constructor(private host: MockServerHost, private projectService: ts.server.ProjectService) {}

  addProject(name: string, files: ProjectFiles, options: TestableOptions = {}): Project {
    if (this.projects.has(name)) {
      throw new Error(`Project ${name} is already defined`);
    }

    const project = Project.initialize(name, this.projectService, files, options);
    this.projects.set(name, project);
    return project;
  }

  getTextFromTsSpan(fileName: string, span: ts.TextSpan): string|null {
    const scriptInfo = this.projectService.getScriptInfo(fileName);
    if (scriptInfo === undefined) {
      return null;
    }
    return scriptInfo.getSnapshot().getText(span.start, span.start + span.length);
  }

  expectNoSourceDiagnostics(): void {
    for (const project of this.projects.values()) {
      project.expectNoSourceDiagnostics();
    }
  }
}

const logger: ts.server.Logger = {
  close(): void{},
  hasLevel(level: ts.server.LogLevel): boolean {
    return false;
  },
  loggingEnabled(): boolean {
    return false;
  },
  perftrc(s: string): void{},
  info(s: string): void{},
  startGroup(): void{},
  endGroup(): void{},
  msg(s: string, type?: ts.server.Msg): void{},
  getLogFileName(): string |
      undefined {
        return;
      },
};
