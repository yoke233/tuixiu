type Props = {
  active: boolean;
};

export function SettingsSection(props: Props) {
  const { active } = props;

  return (
    <section className="card" style={{ marginBottom: 16 }} hidden={!active}>
      <h2 style={{ marginTop: 0 }}>平台设置</h2>
      <div className="muted">
        目前暂无全局选项。看板「主界面显示已归档 Issue」已迁移到「Issue 归档」配置中。
      </div>
    </section>
  );
}
