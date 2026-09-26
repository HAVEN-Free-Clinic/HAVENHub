import { createContext, useContext, useState, type ReactNode } from "react";

/**
 * The unread count behind the Notifications tab badge. Set by whichever screen
 * last heard it from the Hub (Home and Notifications both do), so marking
 * something read updates the badge without another request.
 */
const UnreadContext = createContext<{ unread: number; setUnread: (n: number) => void }>({ unread: 0, setUnread: () => {} });

export function UnreadProvider({ children }: { children: ReactNode }) {
  const [unread, setUnread] = useState(0);
  return <UnreadContext.Provider value={{ unread, setUnread }}>{children}</UnreadContext.Provider>;
}

export function useUnread() {
  return useContext(UnreadContext);
}
