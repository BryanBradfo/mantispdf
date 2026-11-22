import { Link, Trans, useDescribeError } from "../../i18n";
import ErrorText from "../common/ErrorText";
import { needsManualUpdate } from "../../lib/updateErrors";
import { linkClass } from "../../styles/ui";

/** An updater error: "update from the download page" when this install cannot update itself, else described. */
export default function UpdateErrorText({ error, onNavigate }: { error: unknown; onNavigate?: () => void }) {
  const describe = useDescribeError();
  if (needsManualUpdate(error)) {
    return (
      <Trans
        ns="common"
        k="updateManual"
        components={{ link: (c) => <Link to="/download" onClick={onNavigate} className={`${linkClass} !text-danger`}>{c}</Link> }}
      />
    );
  }
  return <ErrorText error={describe(error)} />;
}
