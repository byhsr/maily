import { createContext, useContext } from "react";

type NavValue = {
  mobile: boolean;
  openNav: () => void;
};

export const NavContext = createContext<NavValue>({ mobile: false, openNav: () => {} });

export const useNav = () => useContext(NavContext);
