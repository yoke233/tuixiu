import { useState } from "react";

import { getShowArchivedIssues, setShowArchivedIssues } from "../../../utils/settings";

type Props = {
  active: boolean;
};

export function SettingsSection(props: Props) {
  const { active } = props;
  const [showArchivedOnBoard, setShowArchivedOnBoard] = useState<boolean>(() => getShowArchivedIssues());

  function onShowArchivedOnBoardChange(next: boolean) {
    setShowArchivedOnBoard(next);
    setShowArchivedIssues(next);
  }

  return (
    <section className="card" style={{ marginBottom: 16 }} hidden={!active}>
      <h2 style={{ marginTop: 0 }}>平台设置</h2>
      <label className="row gap">
        <input
          type="checkbox"
          checked={showArchivedOnBoard}
          onChange={(e) => onShowArchivedOnBoardChange(e.target.checked)}
        />
        <span>主界面显示已归档 Issue</span>
      </label>
      <div className="muted" style={{ marginTop: 8 }}>
        关闭时：归档的 Issue 默认不在看板显示；打开后会在对应状态列中显示。
      </div>
    </section>
  );
}

