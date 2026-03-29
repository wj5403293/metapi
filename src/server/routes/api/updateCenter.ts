import { FastifyInstance } from 'fastify';

import {
  appendBackgroundTaskLog,
  getBackgroundTask,
  listBackgroundTasks,
  startBackgroundTask,
  subscribeToBackgroundTaskLogs,
} from '../../services/backgroundTaskService.js';
import {
  fetchLatestDockerHubTag,
  fetchLatestStableGitHubRelease,
  getCurrentRuntimeVersion,
  type UpdateCenterVersionCandidate,
  type UpdateCenterVersionSource,
} from '../../services/updateCenterVersionService.js';
import {
  getDefaultUpdateCenterConfig,
  loadUpdateCenterConfig,
  normalizeUpdateCenterConfig,
  saveUpdateCenterConfig,
  type UpdateCenterConfig,
} from '../../services/updateCenterConfigService.js';
import {
  getUpdateCenterHelperStatus,
  streamUpdateCenterDeploy,
} from '../../services/updateCenterHelperClient.js';

type DeployBody = {
  source?: UpdateCenterVersionSource;
  targetVersion?: string;
};

const UPDATE_CENTER_DEPLOY_TASK_TYPE = 'update-center.deploy';
const UPDATE_CENTER_DEPLOY_DEDUPE_KEY = 'update-center.deploy';

function getUpdateCenterHelperToken(): string {
  return String(process.env.DEPLOY_HELPER_TOKEN || process.env.UPDATE_CENTER_HELPER_TOKEN || '').trim();
}

function assertDeployableConfig(config: UpdateCenterConfig) {
  if (!config.enabled) throw new Error('update center is disabled');
  if (!config.helperBaseUrl) throw new Error('helperBaseUrl is required');
  if (!config.namespace) throw new Error('namespace is required');
  if (!config.releaseName) throw new Error('releaseName is required');
  if (!config.chartRef) throw new Error('chartRef is required');
  if (!config.imageRepository) throw new Error('imageRepository is required');
  if (!getUpdateCenterHelperToken()) throw new Error('DEPLOY_HELPER_TOKEN is required');
}

function getDeployTasks() {
  return listBackgroundTasks(50).filter((task) => task.type === UPDATE_CENTER_DEPLOY_TASK_TYPE);
}

function summarizeHelperError(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || 'unknown helper error');
}

async function buildUpdateCenterStatus() {
  const config = await loadUpdateCenterConfig();

  let githubRelease: UpdateCenterVersionCandidate | null = null;
  let dockerHubTag: UpdateCenterVersionCandidate | null = null;
  let helper: Record<string, unknown> = {
    ok: false,
    healthy: false,
    error: null,
  };

  if (config.githubReleasesEnabled) {
    githubRelease = await fetchLatestStableGitHubRelease();
  }
  if (config.dockerHubTagsEnabled) {
    dockerHubTag = await fetchLatestDockerHubTag();
  }

  if (config.helperBaseUrl) {
    try {
      helper = await getUpdateCenterHelperStatus(config, getUpdateCenterHelperToken());
    } catch (error) {
      helper = {
        ok: false,
        healthy: false,
        error: summarizeHelperError(error),
      };
    }
  }

  const tasks = getDeployTasks();
  const runningTask = tasks.find((task) => task.status === 'pending' || task.status === 'running') || null;
  const lastFinishedTask = tasks.find((task) => task.status === 'succeeded' || task.status === 'failed') || null;

  return {
    currentVersion: getCurrentRuntimeVersion(),
    config,
    githubRelease,
    dockerHubTag,
    helper,
    runningTask,
    lastFinishedTask,
  };
}

function writeSseEvent(reply: { raw: NodeJS.WritableStream & { write: (chunk: string) => void } }, event: string, data: unknown) {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function updateCenterRoutes(app: FastifyInstance) {
  app.get('/api/update-center/status', async () => {
    return await buildUpdateCenterStatus();
  });

  app.post('/api/update-center/check', async () => {
    return await buildUpdateCenterStatus();
  });

  app.put<{ Body: UpdateCenterConfig }>('/api/update-center/config', async (request) => {
    const next = normalizeUpdateCenterConfig(request.body || getDefaultUpdateCenterConfig());
    const saved = await saveUpdateCenterConfig(next);
    return {
      success: true,
      config: saved,
    };
  });

  app.post<{ Body: DeployBody }>('/api/update-center/deploy', async (request, reply) => {
    const config = await loadUpdateCenterConfig();
    try {
      assertDeployableConfig(config);
    } catch (error) {
      return reply.code(400).send({
        success: false,
        message: summarizeHelperError(error),
      });
    }

    const source = request.body?.source === 'docker-hub-tag'
      ? 'docker-hub-tag'
      : request.body?.source === 'github-release'
        ? 'github-release'
        : config.defaultDeploySource;
    const targetVersion = String(request.body?.targetVersion || '').trim();
    if (!targetVersion) {
      return reply.code(400).send({
        success: false,
        message: 'targetVersion is required',
      });
    }

    let taskId = '';
    const { task, reused } = startBackgroundTask(
      {
        type: UPDATE_CENTER_DEPLOY_TASK_TYPE,
        title: '更新中心部署',
        dedupeKey: UPDATE_CENTER_DEPLOY_DEDUPE_KEY,
        successTitle: '更新中心部署已完成',
        failureTitle: '更新中心部署失败',
      },
      async () => {
        await Promise.resolve();
        appendBackgroundTaskLog(taskId, `Resolving target version: ${targetVersion}`);
        appendBackgroundTaskLog(taskId, `Contacting deploy helper: ${config.helperBaseUrl}`);

        const result = await streamUpdateCenterDeploy(
          {
            config,
            helperToken: getUpdateCenterHelperToken(),
            source,
            targetVersion,
          },
          (message) => {
            appendBackgroundTaskLog(taskId, message);
          },
        );

        if (!result.success) {
          throw new Error('deploy helper reported a failed deployment');
        }
        appendBackgroundTaskLog(taskId, result.rolledBack ? 'Deployment rolled back' : 'Deployment finished successfully');
        return result;
      },
    );
    taskId = task.id;

    return reply.code(202).send({
      success: true,
      reused,
      task,
    });
  });

  app.get<{ Params: { id: string } }>('/api/update-center/tasks/:id/stream', async (request, reply) => {
    const taskId = String(request.params.id || '').trim();
    const task = getBackgroundTask(taskId);
    if (!task) {
      return reply.code(404).send({
        success: false,
        message: 'task not found',
      });
    }

    reply.hijack();
    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');

    const writeDone = () => {
      const latest = getBackgroundTask(taskId);
      writeSseEvent(reply, 'done', {
        status: latest?.status || 'unknown',
      });
      reply.raw.end();
    };

    for (const entry of task.logs) {
      writeSseEvent(reply, 'log', entry);
    }

    if (task.status !== 'pending' && task.status !== 'running') {
      writeDone();
      return;
    }

    const unsubscribe = subscribeToBackgroundTaskLogs(taskId, (entry) => {
      writeSseEvent(reply, 'log', entry);
    });

    const interval = setInterval(() => {
      const latest = getBackgroundTask(taskId);
      if (!latest) {
        clearInterval(interval);
        unsubscribe();
        writeDone();
        return;
      }
      if (latest.status !== 'pending' && latest.status !== 'running') {
        clearInterval(interval);
        unsubscribe();
        writeDone();
      }
    }, 25);
    interval.unref?.();

    request.raw.on('close', () => {
      clearInterval(interval);
      unsubscribe();
    });
  });
}
