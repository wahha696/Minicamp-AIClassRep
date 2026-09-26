// D1 占位页：D2~D7 逐个替换成真页面。
export default function Placeholder({ title, task }: { title: string; task: string }) {
  return (
    <section className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
      <h1 className="text-xl font-semibold text-slate-800">{title}</h1>
      <p className="mt-2 text-sm text-slate-400">页面开发中（{task}）</p>
    </section>
  );
}
