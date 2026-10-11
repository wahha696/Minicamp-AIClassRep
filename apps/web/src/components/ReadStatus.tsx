import { errorText } from '../lib/errors';

export default function ReadStatus({ error, cached, lastSuccessAt, onRetry }: {
  error: Error | undefined;
  cached: boolean;
  lastSuccessAt?: number;
  onRetry: () => void;
}) {
  if (!error) return null;
  const time = lastSuccessAt === undefined ? '' : new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(lastSuccessAt);
  return <div role="status" className="my-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
    <p>{cached ? `更新失败，以下为上次成功数据${time ? `（${time}）` : ''}` : '暂时无法读取，不能确定是否有安排'}</p>
    <p className="mt-1 text-xs">{errorText(error)} <button type="button" className="ml-2 underline" onClick={onRetry}>重试</button></p>
  </div>;
}
