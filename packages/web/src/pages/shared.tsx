import { Link } from "@tanstack/react-router";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ApiError } from "../lib/api";

export function QueryError({ error }: { error: Error }) {
  if (error instanceof ApiError && error.status === 401) {
    return (
      <Card className="flex flex-col items-start gap-3 p-5">
        <p className="font-medium">Connect to your controller</p>
        <p className="text-sm text-muted">
          Enter the API token from <span className="font-mono">~/.config/panem/config.json</span> on
          the controller.
        </p>
        <Link to="/settings">
          <Button variant="primary">Set token</Button>
        </Link>
      </Card>
    );
  }
  return (
    <Card className="p-5 text-sm text-bad">Couldn't reach the controller: {error.message}</Card>
  );
}
