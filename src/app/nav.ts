import { createContext, useContext } from "react";

type NavValue = {
  mobile: boolean;
  openNav: () => void;
  /** The sidebar's own state and its setter, so a page that wants the width — the Inbox
      with a conversation open — can put the sidebar away and hand it back afterwards. */
  collapsed: boolean;
  setCollapsed: (value: boolean) => void;
};

export const NavContext = createContext<NavValue>({
  mobile: false,
  openNav: () => {},
  collapsed: false,
  setCollapsed: () => {},
});

export const useNav = () => useContext(NavContext);
