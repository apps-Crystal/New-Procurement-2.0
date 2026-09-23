Crystal Assets & Procurement — clickable prototype
==================================================

index.html
  The complete working prototype: all 15 screens in one file.
  Double-click to open it in any modern browser (Chrome, Edge, Firefox, Safari).
  No server or install needed. An internet connection only loads the fonts;
  without it the page falls back to system fonts and still works.

  Screens share one set of data, so actions carry across them
  (approving a GRN updates warehouse stock and the stock ledger, dispatching
  a return creates the debit note in Accounts, and so on).
  Reloading the page resets the demo.

  Jump straight to a screen by adding its name after #, e.g. index.html#qc
    #main      Warehouse stock          #gate     Gate inward
    #ledger    Stock ledger             #qc       QA/QC inspection
    #damage    Damaged & missing        #grn      Goods receipt (GRN)
    #mr        Material request         #returns  Purchase returns
    #raisepr   Raise purchase request   #notes    Debit & credit notes
    #pr        PR approval              #recon    Vendor reconciliation
    #quotes    Vendor quotations
    #compare   Quote comparison
    #po        Purchase order

canvas-source/
  Source files of the design canvas (one per screen). These use the canvas
  editor's component format and do not open on their own in a browser —
  they are included for reference only. Use index.html to click through.
