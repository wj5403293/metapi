import React, { useEffect, useRef, useState } from 'react';

import { api } from '../../api.js';
import { useToast } from '../../components/Toast.js';

type UpdateCenterStatus = {
  currentVersion?: string;
  config?: {
    enabled: boolean;
    helperBaseUrl: string;
    namespace: string;
    releaseName: string;
    chartRef: string;
    imageRepository: string;
    githubReleasesEnabled: boolean;
    dockerHubTagsEnabled: boolean;
    defaultDeploySource: 'github-release' | 'docker-hub-tag';
  };
  githubRelease?: {
    normalizedVersion?: string;
  } | null;
  dockerHubTag?: {
    normalizedVersion?: string;
  } | null;
  helper?: {
    ok?: boolean;
    healthy?: boolean;
    error?: string | null;
  } | null;
  runningTask?: {
    id?: string;
    status?: string;
  } | null;
  lastFinishedTask?: {
    id?: string;
    status?: string;
    finishedAt?: string | null;
  } | null;
};

const DEFAULT_CONFIG: NonNullable<UpdateCenterStatus['config']> = {
  enabled: false,
  helperBaseUrl: '',
  namespace: 'default',
  releaseName: '',
  chartRef: '',
  imageRepository: '1467078763/metapi',
  githubReleasesEnabled: true,
  dockerHubTagsEnabled: true,
  defaultDeploySource: 'github-release',
};

export default function UpdateCenterSection() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [status, setStatus] = useState<UpdateCenterStatus | null>(null);
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [logs, setLogs] = useState<string[]>([]);
  const [taskStatus, setTaskStatus] = useState('');
  const streamAbortRef = useRef<AbortController | null>(null);

  const loadStatus = async () => {
    setLoading(true);
    try {
      const next = await api.getUpdateCenterStatus() as UpdateCenterStatus;
      setStatus(next);
      setConfig(next.config || DEFAULT_CONFIG);
    } catch (error: any) {
      toast.error(error?.message || '加载更新中心失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadStatus();
    return () => {
      streamAbortRef.current?.abort();
    };
  }, []);

  const saveConfig = async () => {
    setSaving(true);
    try {
      const result = await api.saveUpdateCenterConfig(config) as { config?: UpdateCenterStatus['config'] };
      const nextConfig = result.config || config;
      setConfig(nextConfig);
      setStatus((prev) => ({
        ...(prev || {}),
        config: nextConfig,
      }));
      toast.success('更新中心配置已保存');
    } catch (error: any) {
      toast.error(error?.message || '保存更新中心配置失败');
    } finally {
      setSaving(false);
    }
  };

  const checkNow = async () => {
    setChecking(true);
    try {
      const next = await api.checkUpdateCenter() as UpdateCenterStatus;
      setStatus((prev) => ({
        ...(prev || {}),
        ...next,
      }));
      toast.success('已刷新更新信息');
    } catch (error: any) {
      toast.error(error?.message || '检查更新失败');
    } finally {
      setChecking(false);
    }
  };

  const runDeploy = async (source: 'github-release' | 'docker-hub-tag', targetVersion: string) => {
    if (!targetVersion) return;
    setDeploying(true);
    setLogs([]);
    setTaskStatus('running');
    streamAbortRef.current?.abort();
    streamAbortRef.current = new AbortController();
    let taskId = '';

    try {
      const response = await api.deployUpdateCenter({ source, targetVersion }) as { task?: { id: string } };
      taskId = response.task?.id || '';
      if (!taskId) {
        throw new Error('部署任务未返回 taskId');
      }

      await api.streamUpdateCenterTaskLogs(taskId, {
        signal: streamAbortRef.current.signal,
        onLog: (entry) => {
          const message = String(entry?.message || '').trim();
          if (!message) return;
          setLogs((prev) => [...prev, message].slice(-200));
        },
        onDone: (payload) => {
          setTaskStatus(String(payload?.status || 'unknown'));
        },
      });
    } catch (error: any) {
      if (taskId) {
        try {
          const taskResponse = await api.getTask(taskId) as { task?: { status?: string; logs?: Array<{ message?: string }> } };
          const task = taskResponse.task;
          if (task) {
            setTaskStatus(String(task.status || 'unknown'));
            setLogs(Array.isArray(task.logs) ? task.logs.map((entry) => String(entry?.message || '')).filter(Boolean) : []);
            toast.info('实时日志流已断开，已回退到任务详情快照');
            return;
          }
        } catch {
          // fall through to the generic error state
        }
      }
      setTaskStatus('failed');
      toast.error(error?.message || '部署失败');
    } finally {
      setDeploying(false);
      void loadStatus();
    }
  };

  if (loading) {
    return <div className="card" style={{ padding: 20 }}>加载更新中心...</div>;
  }

  return (
    <div className="card" style={{ padding: 20, marginTop: 16 }}>
      <div className="page-header" style={{ marginBottom: 12 }}>
        <h3 className="page-title">更新中心</h3>
      </div>

      <div style={{ display: 'grid', gap: 12 }}>
        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(e) => setConfig((prev) => ({ ...prev, enabled: e.target.checked }))}
              style={{ width: 16, height: 16, accentColor: 'var(--color-primary)' }}
            />
            启用更新中心
          </span>
        </label>
        <label style={{ display: 'grid', gap: 6 }}>
          <span>Deploy Helper URL</span>
          <input value={config.helperBaseUrl} onChange={(e) => setConfig((prev) => ({ ...prev, helperBaseUrl: e.target.value }))} />
        </label>
        <label style={{ display: 'grid', gap: 6 }}>
          <span>Namespace</span>
          <input value={config.namespace} onChange={(e) => setConfig((prev) => ({ ...prev, namespace: e.target.value }))} />
        </label>
        <label style={{ display: 'grid', gap: 6 }}>
          <span>Release Name</span>
          <input value={config.releaseName} onChange={(e) => setConfig((prev) => ({ ...prev, releaseName: e.target.value }))} />
        </label>
        <label style={{ display: 'grid', gap: 6 }}>
          <span>Chart Ref</span>
          <input value={config.chartRef} onChange={(e) => setConfig((prev) => ({ ...prev, chartRef: e.target.value }))} />
        </label>
        <label style={{ display: 'grid', gap: 6 }}>
          <span>Image Repository</span>
          <input value={config.imageRepository} onChange={(e) => setConfig((prev) => ({ ...prev, imageRepository: e.target.value }))} />
        </label>
        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={config.githubReleasesEnabled}
              onChange={(e) => setConfig((prev) => ({ ...prev, githubReleasesEnabled: e.target.checked }))}
              style={{ width: 16, height: 16, accentColor: 'var(--color-primary)' }}
            />
            启用 GitHub Releases 检查
          </span>
        </label>
        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={config.dockerHubTagsEnabled}
              onChange={(e) => setConfig((prev) => ({ ...prev, dockerHubTagsEnabled: e.target.checked }))}
              style={{ width: 16, height: 16, accentColor: 'var(--color-primary)' }}
            />
            启用 Docker Hub 检查
          </span>
        </label>
        <label style={{ display: 'grid', gap: 6 }}>
          <span>默认部署来源</span>
          <select
            value={config.defaultDeploySource}
            onChange={(e) => setConfig((prev) => ({
              ...prev,
              defaultDeploySource: e.target.value === 'docker-hub-tag' ? 'docker-hub-tag' : 'github-release',
            }))}
            style={{
              minHeight: 40,
              borderRadius: 10,
              border: '1px solid var(--color-border-light)',
              padding: '0 12px',
              background: 'var(--color-bg-card)',
              color: 'var(--color-text-primary)',
            }}
          >
            <option value="github-release">GitHub Releases</option>
            <option value="docker-hub-tag">Docker Hub Tags</option>
          </select>
        </label>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={saveConfig} disabled={saving} className="btn btn-primary">保存更新中心配置</button>
          <button onClick={checkNow} disabled={checking} className="btn btn-secondary">检查更新</button>
        </div>

        <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
          当前版本：{status?.currentVersion || '-'}
        </div>

        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ border: '1px solid var(--color-border-light)', borderRadius: 10, padding: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>GitHub 稳定版</div>
            <div style={{ marginBottom: 8 }}>{status?.githubRelease?.normalizedVersion || '未发现'}</div>
            <button
              onClick={() => void runDeploy('github-release', status?.githubRelease?.normalizedVersion || '')}
              disabled={deploying || !config.enabled || !status?.githubRelease?.normalizedVersion}
              className="btn btn-primary"
            >
              部署 GitHub 稳定版
            </button>
          </div>

          <div style={{ border: '1px solid var(--color-border-light)', borderRadius: 10, padding: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Docker Hub</div>
            <div style={{ marginBottom: 8 }}>{status?.dockerHubTag?.normalizedVersion || '未发现'}</div>
            <button
              onClick={() => void runDeploy('docker-hub-tag', status?.dockerHubTag?.normalizedVersion || '')}
              disabled={deploying || !config.enabled || !status?.dockerHubTag?.normalizedVersion}
              className="btn btn-secondary"
            >
              部署 Docker Hub 标签
            </button>
          </div>
        </div>

        <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
          Helper 状态：{status?.helper?.healthy ? 'healthy' : status?.helper?.ok ? 'ok' : 'unavailable'}
        </div>
        {status?.helper?.error ? (
          <div style={{ fontSize: 12, color: 'var(--color-danger)' }}>
            Helper 错误：{status.helper.error}
          </div>
        ) : null}
        <div style={{ display: 'grid', gap: 6, fontSize: 13, color: 'var(--color-text-secondary)' }}>
          <div>运行中任务：{status?.runningTask?.status || '无'}</div>
          <div>最近完成任务：{status?.lastFinishedTask?.status || '无'}</div>
        </div>

        <div style={{ border: '1px solid var(--color-border-light)', borderRadius: 10, padding: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>部署日志</div>
          <div style={{ marginBottom: 8 }}>任务状态：{taskStatus || 'idle'}</div>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{logs.join('\n')}</pre>
        </div>
      </div>
    </div>
  );
}
