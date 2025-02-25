/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

/// <reference types="node"/>
/// <reference lib="es2020"/>

import {runAsWorker, runWorkerLoop} from '@bazel/worker';
import {Extractor, ExtractorConfig, ExtractorMessage, IConfigFile, IExtractorConfigPrepareOptions} from '@microsoft/api-extractor';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Bundles the specified entry-point and writes the output `d.ts` bundle to the specified
 * output path. An optional license banner can be provided to be added to the bundle output.
 *
 * 打包指定的入口点并将输出 `d.ts`
 * 包写入指定的输出路径。可以提供一个可选的许可证横幅以添加到包输出。
 *
 */
export async function runMain(
    {entryPointExecpath, outputExecpath, packageJsonExecpath, licenseBannerExecpath}: {
      entryPointExecpath: string,
      outputExecpath: string,
      packageJsonExecpath: string,
      licenseBannerExecpath: string|undefined
    }): Promise<void> {
  const configObject: IConfigFile = {
    compiler: {
      overrideTsconfig:
          // We disable automatic `@types` resolution as this throws-off API reports
          // when the API test is run outside sandbox. Instead we expect a list of
          // hard-coded types that should be included. This works in non-sandbox too.
          {files: [entryPointExecpath], compilerOptions: {types: [], lib: ['es2020', 'dom']}},
    },
    // The execroot is the working directory and it will contain all input files.
    projectFolder: process.cwd(),
    mainEntryPointFilePath: path.resolve(entryPointExecpath),
    newlineKind: 'lf',
    apiReport: {enabled: false, reportFileName: 'invalid'},
    docModel: {enabled: false},
    tsdocMetadata: {enabled: false},
    dtsRollup: {
      enabled: true,
      untrimmedFilePath: path.resolve(outputExecpath),
    },
  };

  // Resolve to an absolute path from the current working directory (i.e. execroot).
  const packageJsonFullPath = path.resolve(packageJsonExecpath);
  const options: IExtractorConfigPrepareOptions = {
    configObject,
    packageJsonFullPath,
    packageJson: undefined,
    configObjectFullPath: undefined,
  };

  const extractorConfig = ExtractorConfig.prepare(options);
  const {succeeded} =
      Extractor.invoke(extractorConfig, {messageCallback: handleApiExtractorMessage});

  if (!succeeded) {
    throw new Error('Type bundling failed. See error above.');
  }

  let bundleOutput = fs.readFileSync(outputExecpath, 'utf8');

  // Strip AMD module directive comments.
  bundleOutput = stripAmdModuleDirectiveComments(bundleOutput);

  // Remove license comments as these are not deduped in API-extractor.
  bundleOutput = bundleOutput.replace(/(\/\*\*\s+\*\s\@license(((?!\*\/).|\s)*)\*\/)/gm, '');

  // Add license banner if provided.
  if (licenseBannerExecpath) {
    bundleOutput = `${fs.readFileSync(licenseBannerExecpath, 'utf8')}\n\n` + bundleOutput;
  }

  // Re-write the output file.
  fs.writeFileSync(outputExecpath, bundleOutput);
}

/**
 * Strip the named AMD module for compatibility from Bazel-generated type
 * definitions. These may end up in the generated type bundles.
 *
 * 从 Bazel 生成的类型定义中剥离命名的 AMD 模块以实现兼容性。这些可能最终会出现在生成的类型包中。
 *
 * e.g. `/// <amd-module name="@angular/localize/init" />` should be stripped.
 *
 * 例如 `/// <amd-module name="@angular/localize/init" />` 应该被剥离。
 *
 */
function stripAmdModuleDirectiveComments(content: string): string {
  return content.replace(/^\/\/\/ <amd-module name=.*\/>[\r\n]+/gm, '');
}

/**
 * Handles logging messages from API extractor.
 *
 * 处理来自 API 提取器的日志消息。
 *
 * Certain info messages should be omitted and other messages should be printed
 * to stderr to avoid worker protocol conflicts.
 *
 * 应省略某些信息消息，并应将其他消息打印到 stderr 以避免工作器协议冲突。
 *
 */
function handleApiExtractorMessage(msg: ExtractorMessage): void {
  msg.handled = true;

  if (msg.messageId === 'console-compiler-version-notice' || msg.messageId === 'console-preamble') {
    return;
  }

  if (msg.logLevel !== 'verbose' && msg.logLevel !== 'none') {
    console.error(msg.text);
  }
}

/**
 * Runs one build using the specified build action command line arguments.
 *
 * 使用指定的构建操作命令行参数运行一个构建。
 *
 */
async function runOneBuild(args: string[]): Promise<boolean> {
  const [entryPointExecpath, outputExecpath, packageJsonExecpath, licenseBannerExecpath] = args;

  try {
    await runMain({entryPointExecpath, outputExecpath, packageJsonExecpath, licenseBannerExecpath});
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

// Entry-point.
const processArgs = process.argv.slice(2);

if (runAsWorker(processArgs)) {
  runWorkerLoop(runOneBuild);
} else {
  // In non-worker mode we need to manually read the flag file and omit
  // the leading `@` that is added as part of the worker requirements.
  const flagFile = processArgs[0].substring(1);
  const args = fs.readFileSync(flagFile, 'utf8').split('\n');

  runOneBuild(args).then(success => {
    if (!success) {
      process.exitCode = 1;
    }
  });
}
