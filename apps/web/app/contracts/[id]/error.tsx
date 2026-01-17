'use client';

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowLeft, XCircle } from "lucide-react";

export default function Error({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        console.error(error);
    }, [error]);

    return (
        <div className="min-h-screen bg-background">
            <div className="container mx-auto px-4 py-12">
                <Card className="max-w-xl mx-auto">
                    <CardContent className="flex flex-col items-center text-center py-10">
                        <div className="rounded-full bg-destructive/10 p-3 mb-4">
                            <XCircle className="h-8 w-8 text-destructive" />
                        </div>
                        <h2 className="text-xl font-semibold text-foreground">Something went wrong</h2>
                        <p className="text-sm text-muted-foreground mt-2">
                            We hit an unexpected error while loading this contract. You can try again or return to the dashboard.
                        </p>
                        <div className="flex flex-wrap gap-3 mt-6 justify-center">
                            <Button variant="outline" onClick={() => reset()}>
                                Try Again
                            </Button>
                            <Button asChild>
                                <Link href="/dashboard">
                                    <ArrowLeft className="mr-2 h-4 w-4" />
                                    Back to Dashboard
                                </Link>
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
