/**
 * #350 spec §9：/admin/settings 顶部的分区导航「关于我们」「组织信息」。当前分区 aria-current="page"，下划线 --accent。
 * 用普通 <a>（整页跳转到 ?section=org），不用 next/link 的客户端跳转：两个分区各自读写自己的接口和 version，
 * 而且整页跳转才会触发各分区的 beforeunload「有未保存的修改，确定离开？」。
 */
export const SETTINGS_SECTIONS = [
  { id: 'about', label: '关于我们', href: '/admin/settings' },
  { id: 'org', label: '组织信息', href: '/admin/settings?section=org' },
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id'];
export const sectionFrom = (v: string | string[] | undefined): SettingsSection => (v === 'org' ? 'org' : 'about');

export default function SettingsSections({ current }: { current: SettingsSection }) {
  return (
    <nav className="st-sections" aria-label="站点设置分区">
      {SETTINGS_SECTIONS.map((s) => (
        <a key={s.id} href={s.href} aria-current={s.id === current ? 'page' : undefined}>{s.label}</a>
      ))}
    </nav>
  );
}
