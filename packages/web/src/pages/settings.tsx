import { Check } from "lucide-react";
import { useState } from "react";
import { CredentialsCard } from "../components/credentials-card";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Field, Input } from "../components/ui/field";
import { getToken, hasToken, queryClient, setToken } from "../lib/api";

export function SettingsPage() {
  const [value, setValue] = useState(getToken());
  const [saved, setSaved] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setToken(value.trim());
          setSaved(true);
          queryClient.invalidateQueries();
        }}
      >
        <h1 className="text-xl font-semibold">Settings</h1>
        <Card className="flex flex-col gap-4 p-4">
          <Field
            label="API token"
            htmlFor="token"
            hint="Stored in this browser only. Find it in ~/.config/panem/config.json on the controller, or run `panem token`."
          >
            <Input
              id="token"
              type="password"
              autoComplete="off"
              className="font-mono"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setSaved(false);
              }}
            />
          </Field>
          <Button type="submit" variant="primary" disabled={!value.trim()}>
            {saved ? (
              <>
                <Check /> Saved
              </>
            ) : (
              "Save token"
            )}
          </Button>
        </Card>
      </form>
      {hasToken() && <CredentialsCard />}
    </div>
  );
}
