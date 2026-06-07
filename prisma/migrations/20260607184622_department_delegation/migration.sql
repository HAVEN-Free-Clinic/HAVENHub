-- CreateTable
CREATE TABLE "DepartmentDelegation" (
    "id" TEXT NOT NULL,
    "managerDepartmentId" TEXT NOT NULL,
    "managedDepartmentId" TEXT NOT NULL,

    CONSTRAINT "DepartmentDelegation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DepartmentDelegation_managerDepartmentId_managedDepartmentI_key" ON "DepartmentDelegation"("managerDepartmentId", "managedDepartmentId");

-- AddForeignKey
ALTER TABLE "DepartmentDelegation" ADD CONSTRAINT "DepartmentDelegation_managerDepartmentId_fkey" FOREIGN KEY ("managerDepartmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentDelegation" ADD CONSTRAINT "DepartmentDelegation_managedDepartmentId_fkey" FOREIGN KEY ("managedDepartmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;
