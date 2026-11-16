// 何時讓 react-router 的導覽使用 View Transition：只有換頁（pathname 改變）才交叉淡化；同一頁只改 query（例如在樹上
// 選另一個元件、另一個元件組合的 query）時就地更新，不讓整個主要內容重新進場。
export function pathnameOf(to: string): string {
  const end = to.search(/[?#]/);
  return end < 0 ? to : to.slice(0, end);
}

export function changesPage(to: string, currentPathname: string): boolean {
  return pathnameOf(to) !== currentPathname;
}
