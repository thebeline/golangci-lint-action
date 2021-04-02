import * as core from "@actions/core"
import * as github from "@actions/github"
import { exec, ExecOptions } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { dir } from "tmp"
import { promisify } from "util"

import { restoreCache, saveCache } from "./cache"
import { installGo, installLint } from "./install"
import { findLintVersion } from "./version"

const execShellCommand = promisify(exec)
const writeFile = promisify(fs.writeFile)
const createTempDir = promisify(dir)

async function prepareLint(): Promise<string> {
  const versionConfig = await findLintVersion()
  return await installLint(versionConfig)
}

async function fetchPatch(): Promise<string> {
  const onlyNewIssues = core.getInput(`only-new-issues`, { required: true }).trim()
  if (onlyNewIssues !== `false` && onlyNewIssues !== `true`) {
    throw new Error(`invalid value of "only-new-issues": "${onlyNewIssues}", expected "true" or "false"`)
  }
  if (onlyNewIssues === `false`) {
    return ``
  }

  const ctx = github.context
  if (ctx.eventName !== `pull_request`) {
    core.info(`Not fetching patch for showing only new issues because it's not a pull request context: event name is ${ctx.eventName}`)
    return ``
  }
  const pull = ctx.payload.pull_request
  if (!pull) {
    core.warning(`No pull request in context`)
    return ``
  }
  const octokit = github.getOctokit(core.getInput(`github-token`, { required: true }))
  let patch: string
  try {
    const patchResp = await octokit.pulls.get({
      owner: ctx.repo.owner,
      repo: ctx.repo.repo,
      [`pull_number`]: pull.number,
      mediaType: {
        format: `diff`,
      },
    })

    if (patchResp.status !== 200) {
      core.warning(`failed to fetch pull request patch: response status is ${patchResp.status}`)
      return `` // don't fail the action, but analyze without patch
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    patch = patchResp.data as any
  } catch (err) {
    console.warn(`failed to fetch pull request patch:`, err)
    return `` // don't fail the action, but analyze without patch
  }

  try {
    const tempDir = await createTempDir()
    const patchPath = path.join(tempDir, "pull.patch")
    core.info(`Writing patch to ${patchPath}`)
    await writeFile(patchPath, patch)
    return patchPath
  } catch (err) {
    console.warn(`failed to save pull request patch:`, err)
    return `` // don't fail the action, but analyze without patch
  }
}

type Env = {
  lintPath: string
  patchPath: string
}

async function prepareEnv(): Promise<Env> {
  const startedAt = Date.now()

  // Prepare cache, lint and go in parallel.
  const restoreCachePromise = restoreCache()
  const prepareLintPromise = prepareLint()
  const installGoPromise = installGo()
  const patchPromise = fetchPatch()

  const lintPath = await prepareLintPromise
  await installGoPromise
  await restoreCachePromise
  const patchPath = await patchPromise

  core.info(`Prepared env in ${Date.now() - startedAt}ms`)
  return { lintPath, patchPath }
}

type ExecRes = {
  stdout: string
  stderr: string
  code?: number
}

enum LintSeverity {
  notice,
  warning,
  failure,
}

type LintSeverityStrings = keyof typeof LintSeverity

type LintIssue = {
  Text: string
  FromLinter: string
  Severity: LintSeverityStrings
  Pos: {
    Filename: string
    Line: number
    Column: number
  }
  LineRange?: {
    From: number
    To: number
  }
  Replacement: {
    NeedOnlyDelete: boolean
    NewLines: string[]
  } | null
}

type UnfilteredLintIssue =
  | LintIssue
  | {
      Severity: string
    }

type LintOutput = {
  Issues: LintIssue[]
  Report: {
    Warnings?: {
      Tag?: string
      Text: string
    }[]
    Linters?: {
      Enabled: boolean
      Name: string
    }[]
    Error?: string
  }
}

type GithubAnnotation = {
  path: string
  start_line: number
  end_line: number
  start_column?: number
  end_column?: number
  title: string
  message: string
  annotation_level: LintSeverityStrings
  raw_details?: string
}

type SeverityMap = {
  [key: string]: LintSeverityStrings
}

const DefaultFailureSeverity = LintSeverity.notice

const parseOutput = (json: string): LintOutput => {
  const severityMap: SeverityMap = {
    info: `notice`,
    notice: `notice`,
    minor: `warning`,
    warning: `warning`,
    error: `failure`,
    major: `failure`,
    critical: `failure`,
    blocker: `failure`,
    failure: `failure`,
  }
  const lintOutput = JSON.parse(json)
  if (!lintOutput.Report) {
    throw `golangci-lint returned invalid json`
  }
  if (lintOutput.Issues.length) {
    lintOutput.Issues = lintOutput.Issues.filter((issue: UnfilteredLintIssue) => issue.Severity === `ignore`).map(
      (issue: UnfilteredLintIssue): LintIssue => {
        const Severity = issue.Severity.toLowerCase()
        issue.Severity = severityMap[`${Severity}`] ? severityMap[`${Severity}`] : `failure`
        return issue as LintIssue
      }
    )
  }
  return lintOutput as LintOutput
}

const logLintIssues = (issues: LintIssue[]): void => {
  issues.forEach((issue: LintIssue): void => {
    const severity = issue.Severity === `failure` ? `error` : `warning`
    let until = ``

    if (issue.LineRange !== undefined) {
      until = `-${issue.LineRange.To}`
    } else if (issue.Pos.Column) {
      until = `:${issue.Pos.Column}`
    }

    core.info(`::${severity}::${issue.Pos.Filename}:${issue.Pos.Line}${until} - ${issue.Text} (${issue.FromLinter})`)
  })
}

async function annotateLintIssues(issues: LintIssue[]): Promise<void> {
  const ctx = github.context
  const octokit = github.getOctokit(core.getInput(`github-token`, { required: true }))
  const currentCheckPromise = octokit.checks.get({
    owner: ctx.repo.owner,
    repo: ctx.repo.repo,
    [`check_run_id`]: ctx.runId,
  })
  const chunkSize = 50
  const githubAnnotations: GithubAnnotation[] = issues.map(
    (issue: LintIssue): GithubAnnotation => {
      // If/when we transition to comments, we would build the request structure here
      const annotation: GithubAnnotation = {
        path: issue.Pos.Filename,
        start_line: issue.Pos.Line,
        end_line: issue.Pos.Line,
        title: issue.FromLinter,
        message: issue.Text,
        annotation_level: issue.Severity,
      }

      if (issue.LineRange !== undefined) {
        annotation.end_line = issue.LineRange.To
      } else if (issue.Pos.Column) {
        annotation.start_column = issue.Pos.Column
        annotation.end_column = issue.Pos.Column
      }

      if (issue.Replacement !== null) {
        annotation.raw_details = "```suggestion\n" + issue.Replacement.NewLines.join("\n") + "\n```"
      }

      return annotation as GithubAnnotation
    }
  )
  const currentCheck = await currentCheckPromise
  Array.from({ length: Math.ceil(githubAnnotations.length / chunkSize) }, (v, i) =>
    githubAnnotations.slice(i * chunkSize, i * chunkSize + chunkSize)
  ).forEach((annotations: GithubAnnotation[]): void => {
    octokit.checks.update({
      owner: ctx.repo.owner,
      repo: ctx.repo.repo,
      [`check_run_id`]: ctx.runId,
      output: {
        title: currentCheck.data.output.title,
        summary: currentCheck.data.output.title,
        annotations: annotations,
      },
    })
  })
}

const hasFailingIssues = (issues: LintIssue[]): boolean => {
  // If the user input is not a valid Severity Level, this will be -1, and any issue will fail
  const userFailureSeverity = core.getInput(`failure-severity`).toLowerCase()
  let failureSeverity = Object.values(LintSeverity).indexOf(userFailureSeverity)
  if (failureSeverity < 0) {
    core.info(
      `::warning::failure-severity must be one of (${Object.keys(LintSeverity).join(
        " | "
      )}). "${userFailureSeverity}" not supported, using default (${LintSeverity[DefaultFailureSeverity]})`
    )
    failureSeverity = DefaultFailureSeverity
  }
  if (issues.length) {
    if (failureSeverity <= 0) {
      return true
    }
    for (const issue of issues) {
      if (LintSeverity[issue.Severity] >= failureSeverity) {
        return true
      }
    }
  }
  return false
}

async function printOutput(res: ExecRes): Promise<void> {
  let lintOutput: LintOutput | undefined
  const exit_code = res.code ? res.code : 0
  try {
    try {
      if (res.stdout) {
        // This object contains other information, such as errors and the active linters
        // TODO: Should we do something with that data?
        lintOutput = parseOutput(res.stdout)
        logLintIssues(lintOutput.Issues)

        // We can only Annotate (or Comment) on Push or Pull Request
        switch (github.context.eventName) {
          case `pull_request`:
          // TODO: When we are ready to handle these as Comments, instead of Annotations, we would place that logic here
          /* falls through */
          case `push`:
            await annotateLintIssues(lintOutput.Issues)
            break
          default:
            // At this time, other events are not supported
            break
        }
      }
    } catch (e) {
      throw `there was an error processing golangci-lint output: ${e}`
    }

    if (res.stderr) {
      core.info(res.stderr)
    }

    if (exit_code === 1) {
      if (lintOutput) {
        if (hasFailingIssues(lintOutput.Issues)) {
          throw `issues found`
        }
      } else {
        throw `unexpected state, golangci-lint exited with 1, but provided no lint output`
      }
    } else if (exit_code > 1) {
      throw `golangci-lint exit with code ${exit_code}`
    }
  } catch (e) {
    return <void>core.setFailed(`${e}`)
  }
  return <void>core.info(`golangci-lint found no blocking issues`)
}

async function runLint(lintPath: string, patchPath: string): Promise<void> {
  const debug = core.getInput(`debug`)
  if (debug.split(`,`).includes(`cache`)) {
    const res = await execShellCommand(`${lintPath} cache status`)
    printOutput(res)
  }

  const userArgs = core.getInput(`args`)
  const addedArgs: string[] = []

  const userArgNames = new Set<string>()
  userArgs
    .split(/\s/)
    .map((arg) => arg.split(`=`)[0])
    .filter((arg) => arg.startsWith(`-`))
    .forEach((arg) => {
      userArgNames.add(arg.replace(`-`, ``))
    })

  if (userArgNames.has(`out-format`)) {
    throw new Error(`please, don't change out-format for golangci-lint: it can be broken in a future`)
  }
  addedArgs.push(`--out-format=json`)

  if (patchPath) {
    if (userArgNames.has(`new`) || userArgNames.has(`new-from-rev`) || userArgNames.has(`new-from-patch`)) {
      throw new Error(`please, don't specify manually --new* args when requesting only new issues`)
    }
    addedArgs.push(`--new-from-patch=${patchPath}`)

    // Override config values.
    addedArgs.push(`--new=false`)
    addedArgs.push(`--new-from-rev=`)
  }

  const workingDirectory = core.getInput(`working-directory`)
  const cmdArgs: ExecOptions = {}
  if (workingDirectory) {
    if (patchPath) {
      // TODO: make them compatible
      throw new Error(`options working-directory and only-new-issues aren't compatible`)
    }
    if (!fs.existsSync(workingDirectory) || !fs.lstatSync(workingDirectory).isDirectory()) {
      throw new Error(`working-directory (${workingDirectory}) was not a path`)
    }
    if (!userArgNames.has(`path-prefix`)) {
      addedArgs.push(`--path-prefix=${workingDirectory}`)
    }
    cmdArgs.cwd = path.resolve(workingDirectory)
  }

  const cmd = `${lintPath} run ${addedArgs.join(` `)} ${userArgs}`.trimRight()
  core.info(`Running [${cmd}] in [${cmdArgs.cwd || ``}] ...`)
  const startedAt = Date.now()
  try {
    const res = await execShellCommand(cmd, cmdArgs)
    await printOutput(res)
  } catch (exc) {
    // This logging passes issues to GitHub annotations but comments can be more convenient for some users.
    // TODO: support reviewdog or leaving comments by GitHub API.
    await printOutput(exc)
  }

  core.info(`Ran golangci-lint in ${Date.now() - startedAt}ms`)
}

export async function run(): Promise<void> {
  try {
    const { lintPath, patchPath } = await core.group(`prepare environment`, prepareEnv)
    core.addPath(path.dirname(lintPath))
    await core.group(`run golangci-lint`, () => runLint(lintPath, patchPath))
  } catch (error) {
    core.error(`Failed to run: ${error}, ${error.stack}`)
    core.setFailed(error.message)
  }
}

export async function postRun(): Promise<void> {
  try {
    await saveCache()
  } catch (error) {
    core.error(`Failed to post-run: ${error}, ${error.stack}`)
    core.setFailed(error.message)
  }
}
