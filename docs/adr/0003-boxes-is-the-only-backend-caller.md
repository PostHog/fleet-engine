# Boxes is the only caller of a Box backend

Setup, `hedge box`, and worktree boxes reach a box only through the Boxes engine module, which owns the pool, the claims, the box lock, and the idle sweep. Nothing else calls a backend or the Coder CLI. Before this, 19 `coder.ssh` calls and 6 setup operations reached Coder directly, so a second backend would have needed changes in every caller.
