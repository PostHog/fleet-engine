# The Mac runs only T3 Code

Hedge sets up only Linux cloud boxes. The Mac and the phone run the T3 Code app and reach the boxes through T3 Connect, which every box signs in to with `t3 connect link --headless`. We dropped the Mac path, SSH routes, and Coder port forwards from the Mac because each was a second way to do the same thing, and they made setup slower and the tests larger. The cost is the T3 Connect limit of 3 machines on a free account.
