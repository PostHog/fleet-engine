# No silent retry on a backend failure

When a backend fails, Boxes cleans up, logs the outcome, and stops with the cause and the next command, such as the idle boxes to sweep on a quota error. It never retries on its own. A retry on a quota or a slow start makes a second box that costs money, and hides the failure from the person who must fix it.
