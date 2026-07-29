import { redirect } from "next/navigation";

// Vision settings carry no payment UI; settings opens on Usage.
export default function SettingsIndexPage() {
  redirect("/donkeyvision/settings/usage");
}
