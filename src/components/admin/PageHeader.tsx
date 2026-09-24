export default function PageHeader({
  title,
  description,
  actions,
  count,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  /** 右侧标题旁的计数徽章，如「共 12 条」 */
  count?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b pb-4 dark:border-neutral-800">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold">{title}</h1>
          {count ? <span className="badge badge-off">{count}</span> : null}
        </div>
        {description ? <p className="mt-0.5 text-xs text-neutral-500">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
