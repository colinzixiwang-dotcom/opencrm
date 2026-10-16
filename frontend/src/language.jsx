import React from "react";
import { useWorkspace } from "./context";
import { tr } from "./i18n";
export function LanguageSwitcher() {
  const { language, setLanguage } = useWorkspace();
  return (
    <label className="language-switcher">
      <span className="sr-only">{tr("Language")}</span>
      <select
        aria-label={tr("Language")}
        value={language}
        onChange={(e) => setLanguage(e.target.value)}
      >
        <option value="en">English</option>
        <option value="zh-CN">简体中文</option>
      </select>
    </label>
  );
}
